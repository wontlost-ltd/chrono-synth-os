/**
 * P2-A Layer 1 — Core conformance exercised against PlatformKmsClient.
 *
 * Layer 2 (provider) + Layer 3 (live) for AWS/GCP/Azure/Vault are
 * gated on real / fake SDKs and ship in their own test files when each
 * provider lands.
 */

import { randomBytes } from 'node:crypto';
import { PlatformKmsClient } from '../../enterprise/kms-client.js';
import { runCoreConformance } from '../../enterprise/kms-conformance.js';

const testKey = randomBytes(32).toString('base64');

runCoreConformance(() => new PlatformKmsClient(testKey));
