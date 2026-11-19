export async function cookies() { const t = (globalThis as { __token?: string }).__token; return { get: (_: string) => (t ? { value: t } : undefined) }; }
