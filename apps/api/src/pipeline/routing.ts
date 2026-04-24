import type { Deployment } from '@updraft/shared-types';

export interface AssignRouteInput {
  deployment: Deployment;
}

export interface AssignRouteResult {
  route_path: string;
  live_url: string;
}

export interface RouteAssigner {
  assign(input: AssignRouteInput): AssignRouteResult;
}

export interface PathRouteAssignerDeps {
  publicBaseUrl?: string;
}

export function createPathRouteAssigner(deps: PathRouteAssignerDeps = {}): RouteAssigner {
  const baseUrl = (deps.publicBaseUrl ?? process.env['PUBLIC_BASE_URL'] ?? 'http://localhost:8080').replace(/\/+$/, '');
  return {
    assign({ deployment }) {
      const route_path = `/d/${deployment.id}`;
      const live_url = `${baseUrl}${route_path}`;
      return { route_path, live_url };
    },
  };
}
