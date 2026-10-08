// @ts-check
/**
 * OCapN mobile gateway.
 *
 * Lets a personal device (phone, tablet) pair with the pet daemon over
 * OCapN-Noise on a WebSocket and receive attenuated powers — a narrow,
 * auditable facet of the daemon's powers, never the full agent powers.
 *
 * ## Pairing flow
 *
 * The Noise_IK handshake already authenticates the transport: the daemon
 * knows the device's static public key and the device knows the daemon's
 * (via the location designator). What the handshake does *not* provide
 * is the human's authorization to enroll *this* device. That comes from
 * a short-lived pairing code the human reads on the daemon and types
 * into the device:
 *
 * 1. Device dials the daemon's mobile location and calls
 *    `pairing.requestCode()`. The daemon mints a 6-digit code (5-minute
 *    expiry, single use) and surfaces it to the human through the
 *    `onPairingCode` callback (CLI, log, or push to an enrolled client).
 *    The code is never returned over the OCapN channel.
 * 2. The human types the code into the device; the device calls
 *    `pairing.enroll(code, deviceName)`. On success the daemon burns the
 *    code, records the enrollment, and returns `{ powers, resumeToken }`.
 *    `powers` is the attenuated `MobilePowers` facet; `resumeToken` is a
 *    256-bit secret the device stores for future sessions.
 * 3. Later sessions call `pairing.resume(resumeToken)` to get the facet
 *    back. Revoking the enrollment (from the daemon or another enrolled
 *    device) makes the token — and the facet — stop working.
 *
 * ## Attenuation
 *
 * `MobilePowers` exposes exactly the methods a mobile UI needs
 * (pet-name listing/lookup, inbox, device management). It is a fresh exo
 * per enrollment, closing over a revocation flag. The full powers object
 * never crosses the wire.
 *
 * ## Local daemons
 *
 * This module is transport-agnostic: it builds an OCapN-Noise network
 * and attaches a WebSocket transport, but the pairing and attenuation
 * logic does not depend on the transport. A daemon running on the same
 * device as the UI is the same protocol over a loopback location — the
 * client code (`provideSession(location)` + sturdyrefs) is unchanged;
 * only the location's hints differ. A same-device deployment may
 * auto-approve pairing through a local secure channel instead of a
 * typed code, but the enrollment record shape stays the same.
 *
 * ## Status
 *
 * Pairing state (codes, enrollments) is currently in memory and does
 * not survive daemon restart. A production deployment should persist
 * enrollments (the daemon has SQLite) and surface codes through the
 * CLI rather than a bare callback.
 */

/** @import { FarRef } from '@endo/eventual-send' */
/** @import { EndoGuest } from './types.js' */

import { randomBytes, randomInt } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';

import { Fail } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { makeOcapn } from '@endo/ocapn';
import { syrupCodec } from '@endo/ocapn/syrup';
import { makeCryptography } from '@endo/ocapn/cryptography';
import { makeOcapnNoiseNetwork } from '@endo/ocapn-noise';
import { makeWebSocketTransport } from '@endo/ocapn-noise/transport/ws';

import { toHex } from './hex.js';

/**
 * The underlying powers the gateway attenuates. In production this is
 * adapted from the agent's guest powers; the gateway only ever exposes
 * the `MobilePowers` facet below.
 *
 * @typedef {object} MobileHostPowers
 * @property {() => Promise<string[]>} listPetNames
 * @property {(name: string) => Promise<unknown>} lookupPetName
 * @property {() => Promise<unknown[]>} listMessages
 */

/**
 * Adapt a daemon `EndoGuest` to the narrow `MobileHostPowers` contract.
 * This is the production wiring: the daemon passes its agent's guest
 * powers here, and the gateway attenuates them to the `MobilePowers`
 * facet. Method names follow the real `EndoGuest` interface
 * (`readableNameHubMethodGuards` for pet names, `listMessages` for mail).
 *
 * @param {EndoGuest | FarRef<EndoGuest>} guest
 * @returns {MobileHostPowers}
 */
export const adaptGuestToMobilePowers = guest =>
  harden({
    async listPetNames() {
      return E(guest).list();
    },
    async lookupPetName(name) {
      return E(guest).lookup(name);
    },
    async listMessages() {
      return E(guest).listMessages();
    },
  });
harden(adaptGuestToMobilePowers);

/**
 * @typedef {object} DeviceEnrollment
 * @property {string} deviceId
 * @property {string} deviceName
 * @property {number} enrolledAt
 * @property {boolean} revoked
 * @property {unknown} powers
 */

const PAIRING_SWISSNUM = 'mobile-pairing';
const CODE_DIGITS = 6;
const CODE_EXPIRY_MS = 5 * 60 * 1000;
const MAX_PENDING_CODES = 3;
const MAX_ENROLL_ATTEMPTS_PER_MINUTE = 10;

const MobilePairingInterface = M.interface('MobilePairing', {
  requestCode: M.call().returns(M.number()),
  enroll: M.call(M.string(), M.string()).returns(M.promise()),
  resume: M.call(M.string()).returns(M.promise()),
});
harden(MobilePairingInterface);

const MobilePowersInterface = M.interface('MobilePowers', {
  listNames: M.call().returns(M.promise()),
  lookupName: M.call(M.string()).returns(M.promise()),
  listMessages: M.call().returns(M.promise()),
  listDevices: M.call().returns(M.promise()),
  revokeDevice: M.call(M.string()).returns(M.promise()),
});
harden(MobilePowersInterface);

/**
 * Build the pairing bootstrap for one daemon. The returned exo is the
 * only value the OCapN locator exposes; attenuated powers are reachable
 * solely through successful enrollment.
 *
 * @param {MobileHostPowers | FarRef<MobileHostPowers>} powers
 * @param {(code: string) => void} onPairingCode - surfaces a fresh
 *   pairing code to the human operating the daemon.
 */
export const makeMobilePairing = (powers, onPairingCode) => {
  /** @type {Map<string, { expiresAt: number }>} */
  const pendingCodes = new Map();
  /** @type {Map<string, DeviceEnrollment>} */
  const enrollments = new Map();
  /** @type {number[]} */
  const enrollAttempts = [];

  const pruneCodes = () => {
    const now = Date.now();
    for (const [code, { expiresAt }] of pendingCodes) {
      if (expiresAt <= now) pendingCodes.delete(code);
    }
  };

  /** @param {DeviceEnrollment} enrollment */
  const assertLive = enrollment => {
    if (enrollment.revoked) throw Fail`device enrollment revoked`;
  };

  /** @param {string} deviceName */
  const makeEnrollment = deviceName => {
    const deviceId = toHex(randomBytes(8));
    const resumeToken = toHex(randomBytes(32));
    /** @type {DeviceEnrollment} */
    const enrollment = {
      deviceId,
      deviceName,
      enrolledAt: Date.now(),
      revoked: false,
      powers: undefined,
    };
    const powersExo = makeExo('MobilePowers', MobilePowersInterface, {
      async listNames() {
        assertLive(enrollment);
        return E(powers).listPetNames();
      },
      async lookupName(name) {
        assertLive(enrollment);
        return E(powers).lookupPetName(name);
      },
      async listMessages() {
        assertLive(enrollment);
        return E(powers).listMessages();
      },
      async listDevices() {
        assertLive(enrollment);
        return harden(
          [...enrollments.values()].map(e =>
            harden({
              deviceId: e.deviceId,
              deviceName: e.deviceName,
              enrolledAt: e.enrolledAt,
              revoked: e.revoked,
            }),
          ),
        );
      },
      async revokeDevice(deviceId) {
        assertLive(enrollment);
        for (const [token, e] of enrollments) {
          if (e.deviceId === deviceId) {
            e.revoked = true;
            enrollments.delete(token);
            return true;
          }
        }
        return false;
      },
    });
    enrollment.powers = powersExo;
    enrollments.set(resumeToken, enrollment);
    return { powers: powersExo, resumeToken };
  };

  const pairing = makeExo('MobilePairing', MobilePairingInterface, {
    requestCode() {
      pruneCodes();
      if (pendingCodes.size >= MAX_PENDING_CODES) {
        throw Fail`too many pending pairing codes`;
      }
      const code = String(
        randomInt(0, 10 ** CODE_DIGITS),
      ).padStart(CODE_DIGITS, '0');
      pendingCodes.set(code, { expiresAt: Date.now() + CODE_EXPIRY_MS });
      onPairingCode(code);
      return CODE_EXPIRY_MS;
    },
    async enroll(code, deviceName) {
      const now = Date.now();
      enrollAttempts.push(now);
      while (
        enrollAttempts.length > 0 &&
        enrollAttempts[0] <= now - 60_000
      ) {
        enrollAttempts.shift();
      }
      if (enrollAttempts.length > MAX_ENROLL_ATTEMPTS_PER_MINUTE) {
        throw Fail`enrollment rate limit exceeded`;
      }
      const pending = pendingCodes.get(code);
      pendingCodes.delete(code);
      if (!pending || pending.expiresAt <= now) {
        throw Fail`invalid or expired pairing code`;
      }
      if (deviceName.length === 0 || deviceName.length > 64) {
        throw Fail`device name must be 1-64 characters`;
      }
      const { powers: mobilePowers, resumeToken } =
        makeEnrollment(deviceName);
      return harden({ powers: mobilePowers, resumeToken });
    },
    async resume(resumeToken) {
      const enrollment = enrollments.get(resumeToken);
      if (!enrollment || enrollment.revoked) {
        throw Fail`unknown or revoked enrollment`;
      }
      return enrollment.powers;
    },
  });
  return pairing;
};
harden(makeMobilePairing);

/**
 * Start an OCapN-Noise-over-WebSocket listener that pairs mobile
 * devices and serves them attenuated powers.
 *
 * @param {object} options
 * @param {MobileHostPowers | FarRef<MobileHostPowers>} options.powers
 * @param {(code: string) => void} options.onPairingCode
 * @param {string} [options.host]
 * @param {number} [options.port]
 * @param {Promise<never>} [options.cancelled]
 */
export const startOcapnMobileGateway = async ({
  powers,
  onPairingCode,
  host = '127.0.0.1',
  port = 0,
  cancelled = undefined,
}) => {
  const cryptography = makeCryptography(syrupCodec);
  const { privateKeyBytes } = cryptography.makeOcapnKeyPairWithPrivateBytes();

  const network = makeOcapnNoiseNetwork({ codec: syrupCodec });
  const keyId = network.addSigningKeys({ privateKey: privateKeyBytes });
  await network.addTransport(
    makeWebSocketTransport({ WebSocket, WebSocketServer, host, port }),
  );

  const pairing = makeMobilePairing(powers, onPairingCode);
  const ocapn = await makeOcapn({
    codec: syrupCodec,
    network,
    locator: new Map([[PAIRING_SWISSNUM, pairing]]),
    debugLabel: 'ocapn-mobile-gateway',
  });

  if (cancelled) {
    cancelled.catch(() => {
      ocapn.shutdown();
      network.shutdown();
    });
  }

  return harden({
    location: network.locationFor(keyId),
    pairing,
    shutdown: () => {
      ocapn.shutdown();
      network.shutdown();
    },
  });
};
harden(startOcapnMobileGateway);
