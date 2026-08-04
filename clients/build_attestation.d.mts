export interface WebBuildAttestedFile {
  path: string;
  sha256: string;
  size: number;
}

export interface WebBuildAttestation {
  algorithm: "sha256";
  build_id: string;
  bundled_npm_packages: string[];
  distribution_channel:
    | "development"
    | "messenger-direct-apk"
    | "messenger-test-apk"
    | "messenger-store-managed";
  files: WebBuildAttestedFile[];
  payload_sha256: string;
  profile: "development" | "messenger";
  schema: "green-chat-web-build-profile/v2";
}

export declare const WEB_BUILD_ATTESTATION_FILE: ".gc-build-profile.json";
export declare const WEB_BUILD_ATTESTATION_SCHEMA: "green-chat-web-build-profile/v2";
export declare function isWebBuildSidecar(path: unknown): boolean;
export declare function npmPackageNameFromEsbuildInput(
  input: unknown,
): string | null;
export declare function canonicalAttestationJson(value: unknown): string;
export declare function collectWebBuildFiles(
  root: string,
  current?: string,
): Promise<WebBuildAttestedFile[]>;
export declare function verifyExactWebBuildFiles(
  root: string,
  expectedFiles: WebBuildAttestedFile[],
): Promise<WebBuildAttestedFile[]>;
export declare function createWebBuildAttestation(
  root: string,
  options: {
    profile: "development" | "messenger";
    distributionChannel?:
      | "development"
      | "messenger-direct-apk"
      | "messenger-test-apk"
      | "messenger-store-managed";
    buildId: string;
    bundledNpmPackages?: string[];
  },
): Promise<WebBuildAttestation>;
export declare function verifyWebBuildAttestation(
  root: string,
  options: {
    expectedProfile: "development" | "messenger";
    expectedDistributionChannel?:
      | "development"
      | "messenger-direct-apk"
      | "messenger-test-apk"
      | "messenger-store-managed";
    expectedBuildId: string;
  },
): Promise<WebBuildAttestation>;
