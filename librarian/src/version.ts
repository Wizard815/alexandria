// The release this build belongs to. The Docker image sets ALX_RELEASE and ALX_VERSION from the
// files RELEASE_NAME and VERSION at the repo root; running from source uses these defaults.
export const RELEASE = process.env.ALX_RELEASE || 'AlphaV1';
export const VERSION = process.env.ALX_VERSION || '0.1.0-alpha.1';
