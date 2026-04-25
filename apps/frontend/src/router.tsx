import { Outlet, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { AppPage } from './routes/app-page';
import type { QueryClient } from '@tanstack/react-query';

const rootRoute = createRootRoute<{
  queryClient: QueryClient;
}>({
  component: () => <Outlet />,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: AppPage,
});

export const routeTree = rootRoute.addChildren([indexRoute]);

export const router = createRouter({
  routeTree,
  context: {
    queryClient: undefined as never,
  },
});
