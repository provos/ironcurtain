/** Generated protocol/layout metadata. No executable byte pins. */
// prettier-ignore
export const BUILD_TRUST_RUNTIME_CONTRACT = {
  "schemaVersion": 2,
  "wrapper": {
    "packagePaths": {
      "amd64": "docker/build-trust-runtime/bin/linux-amd64/ironcurtain-build-trust-runc",
      "arm64": "docker/build-trust-runtime/bin/linux-arm64/ironcurtain-build-trust-runc"
    },
    "packageMode": "0755",
    "guestMode": "0555"
  },
  "realRunc": {
    "path": "/ironcurtain-real-runc",
    "mode": "0755",
    "nlink": 1,
    "version": "1.3.4",
    "requiresEffectiveReadOnly": true
  },
  "trustContract": {
    "parentDirectory": {
      "path": "/ironcurtain-build-trust",
      "mode": "0755",
      "requiresEffectiveReadOnly": true
    },
    "mode": "0444",
    "nlink": 1,
    "requiresEffectiveReadOnly": true
  },
  "failureDiagnostic": {
    "path": "/tmp/.ironcurtain-build-trust-runc-failure-v1",
    "clearCommand": "--ironcurtain-internal-clear-failure-v1",
    "readCommand": "--ironcurtain-internal-read-failure-v1",
    "unavailableCode": "ICBT-DIAGNOSTIC-UNAVAILABLE-V1",
    "maxCodeBytes": 128,
    "allowedCodes": [
      "ICBT-RUNC-GRAMMAR-V1",
      "ICBT-CONTRACT-LOAD-V1",
      "ICBT-EXECUTOR-OPEN-V1",
      "ICBT-EXECUTOR-METADATA-V1",
      "ICBT-BUNDLE-OPEN-V1",
      "ICBT-BUNDLE-METADATA-V1",
      "ICBT-SOURCE-CA-CERT-OPEN-V1",
      "ICBT-SOURCE-CA-CERT-METADATA-V1",
      "ICBT-SOURCE-CA-CERT-READONLY-V1",
      "ICBT-SOURCE-CA-BUNDLE-OPEN-V1",
      "ICBT-SOURCE-CA-BUNDLE-METADATA-V1",
      "ICBT-SOURCE-CA-BUNDLE-READONLY-V1",
      "ICBT-SOURCE-APT-CONFIG-OPEN-V1",
      "ICBT-SOURCE-APT-CONFIG-METADATA-V1",
      "ICBT-SOURCE-APT-CONFIG-READONLY-V1",
      "ICBT-CONFIG-OPEN-V1",
      "ICBT-CONFIG-METADATA-V1",
      "ICBT-CONFIG-READ-V1",
      "ICBT-CONFIG-STRICT-ENVELOPE-V1",
      "ICBT-CONFIG-PATCH-V1",
      "ICBT-CONFIG-ATOMIC-COMMIT-V1",
      "ICBT-REAL-RUNC-VALIDATION-V1",
      "ICBT-REAL-RUNC-HANDOFF-V1",
      "ICBT-INTERNAL-ERROR-V1"
    ]
  }
} as const;
