// Everything read from the environment, in one place, with the message a
// person needs when it is missing.

export type Config = {
  port: number;
  host: string;
  secureCookies: boolean;
  publicBaseUrl: string;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env["PORT"] ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`PORT must be a port number; got ${env["PORT"]}`);
  const publicBaseUrl = env["PUBLIC_BASE_URL"] ?? `http://localhost:${port}`;
  return {
    port,
    host: env["HOST"] ?? "127.0.0.1",
    // Cookies are marked Secure whenever the public address is https, which
    // it must be anywhere but a developer's machine.
    secureCookies: publicBaseUrl.startsWith("https://"),
    publicBaseUrl,
  };
}
