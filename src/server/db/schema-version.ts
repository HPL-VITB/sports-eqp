/** Highest migration this build expects. A test checks it matches db/migrations; /api/health compares it with the database. */
export const EXPECTED_SCHEMA_VERSION = "0005";
