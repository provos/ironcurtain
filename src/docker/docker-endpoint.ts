/** Capture the selected local Docker endpoint once for an entire workload lease. */
import { resolve } from 'node:path';
import { z } from 'zod';
import type { ExecFileFn } from './docker-manager.js';

export const dockerEndpointSchema = z
  .object({
    host: z
      .string()
      .max(4096)
      .refine((host) => {
        if (!host.startsWith('unix:///') || /[\p{Cc}\s?#%]/u.test(host)) return false;
        const path = host.slice('unix://'.length);
        return path !== '/' && resolve(path) === path;
      }, 'qualified nested Docker requires a canonical local Unix endpoint'),
  })
  .strict();
export const DOCKER_ENDPOINT_ENVIRONMENT_KEYS = [
  'DOCKER_HOST',
  'DOCKER_CONTEXT',
  'DOCKER_TLS',
  'DOCKER_TLS_VERIFY',
  'DOCKER_CERT_PATH',
  // Bound operations use the admitted server's execution architecture.
  'DOCKER_DEFAULT_PLATFORM',
] as const;
export type DockerEndpoint = Readonly<z.infer<typeof dockerEndpointSchema>>;

/** Explicit flags and environment prevent later context selection from retargeting a lease. */
export function dockerEndpointEnvironment(
  endpoint: DockerEndpoint,
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      Object.entries(environment).filter(
        ([key]) => !DOCKER_ENDPOINT_ENVIRONMENT_KEYS.some((selected) => selected === key),
      ),
    ),
    DOCKER_HOST: dockerEndpointSchema.parse(endpoint).host,
  };
}

export function bindDockerEndpointExec(endpoint: DockerEndpoint, exec: ExecFileFn): ExecFileFn {
  const selected = dockerEndpointSchema.parse(endpoint);
  return (command, args, options) =>
    exec(command, command === 'docker' ? ['--host', selected.host, ...args] : args, {
      ...options,
      env: dockerEndpointEnvironment(selected, options.env ?? process.env),
    });
}

export async function resolveDockerEndpoint(
  exec: ExecFileFn,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<DockerEndpoint> {
  const env = { ...environment };
  if (!env.DOCKER_CONTEXT && env.DOCKER_HOST) return parseSelectedEndpoint(env.DOCKER_HOST);
  const context =
    env.DOCKER_CONTEXT || (await exec('docker', ['context', 'show'], { timeout: 10_000, env })).stdout.trim();
  if (!context || context.startsWith('-')) throw new Error('Docker did not resolve a selected context');
  const result = await exec('docker', ['context', 'inspect', context, '--format', '{{json .Endpoints.docker.Host}}'], {
    timeout: 10_000,
    env,
  });
  return parseSelectedEndpoint(JSON.parse(result.stdout) as unknown);
}

function parseSelectedEndpoint(host: unknown): DockerEndpoint {
  try {
    return dockerEndpointSchema.parse({ host });
  } catch (error) {
    throw new Error(
      'Nested Docker requires a local Docker Desktop Unix socket. Select a Docker Desktop context with a unix:/// endpoint, or set DOCKER_HOST to that socket and unset DOCKER_CONTEXT. TCP and SSH endpoints are not qualified for nested Docker; disable dockerWorkload to use ordinary Docker sessions.',
      { cause: error },
    );
  }
}
