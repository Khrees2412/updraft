#!/usr/bin/env bun
/**
 * Recovery script to restore Caddy routes for deployments that have
 * running containers but missing Caddy routes.
 * 
 * Run with: bun scripts/recover-routes.ts
 */

const CADDY_ADMIN_URL = process.env.CADDY_ADMIN_URL ?? 'http://localhost:2019';
const INTERNAL_PORT = Number(process.env.APP_INTERNAL_PORT ?? 3000);

async function main() {
  console.log('Discovering running deployment containers...');

  const { default: Dockerode } = await import('dockerode');
  const docker = new Dockerode();

  const containers = await docker.listContainers({ all: false });

  const deploymentContainers = containers.filter(c =>
    c.Labels?.['updraft.deployment']
  );

  console.log(`Found ${deploymentContainers.length} deployment container(s)`);

  for (const container of deploymentContainers) {
    const deploymentId = container.Labels!['updraft.deployment'];
    const port = container.Labels?.['updraft.port'] ?? INTERNAL_PORT;

    console.log(`\nChecking route for ${deploymentId}...`);

    try {
      const routeId = `dep-${deploymentId}`;

      const checkRes = await fetch(`${CADDY_ADMIN_URL}/id/${routeId}`);
      if (checkRes.ok) {
        console.log(`  ✓ Route already exists`);
        continue;
      }

      await fetch(`${CADDY_ADMIN_URL}/config/apps/http/servers/updraft/routes/1`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          '@id': routeId,
          'match': [
            { 'path': [`/d/${deploymentId}`, `/d/${deploymentId}/*`] }
          ],
          'handle': [
            {
              'handler': 'subroute',
              'routes': [
                {
                  'handle': [
                    {
                      'handler': 'rewrite',
                      'strip_path_prefix': `/d/${deploymentId}`
                    },
                    {
                      'handler': 'reverse_proxy',
                      'upstreams': [
                        { 'dial': `${container.Names[0].replace(/^\//, '')}:${port}` }
                      ]
                    }
                  ]
                }
              ]
            }
          ]
        })
      });

      console.log(`  ✓ Route restored`);
    } catch (err) {
      console.error(`  ✗ Failed:`, err);
    }
  }

  console.log('\nDone');
}

main().catch(console.error);