// The whole Atlas server, viewer and API, as one function. Everything it needs comes from the environment:
// BLOB_READ_WRITE_TOKEN (set when the Blob store is connected), ATLAS_TOKEN and ATLAS_READ_TOKEN. This file holds no
// Atlas logic, so upgrading is bumping @crvouga/atlas in package.json (Dependabot does it, and merges it).
import { createAtlasHandler } from '@crvouga/atlas/server/serverless';

const handle = createAtlasHandler();

export const GET = handle;
export const HEAD = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
export const OPTIONS = handle;
