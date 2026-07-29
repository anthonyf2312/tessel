export { createGitHubClient, type GitHubClient, type GitHubClientOptions, type FetchResult } from './fetch.ts';
export { installModule, type InstallRequest, type InstallResult, type InstalledArtifact } from './install.ts';
export { parseGitHubUrl, type GitHubSource, type GitHubUrlResult } from './github.ts';
export { resolveEntryPath } from './paths.ts';
export { extractTarball, type ExtractLimits, type ExtractResult } from './extract.ts';
export { bundleModule, type BundleResult } from './bundle.ts';
export {
  verifyCatalogue,
  trustStateFor,
  isRevoked,
  type ArtifactIdentity,
  type Catalogue,
  type TrustState,
  type VerifyResult,
} from './signing.ts';
