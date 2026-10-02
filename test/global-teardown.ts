export default async function globalTeardown(): Promise<void> {
  const containers = ((globalThis as any).__CONTAINERS__ ?? []) as { stop(): Promise<unknown> }[];
  await Promise.all(containers.map((c) => c.stop()));
}
