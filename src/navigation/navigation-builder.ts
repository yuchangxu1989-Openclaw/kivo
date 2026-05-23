import type { NavigationState, SystemStatus } from './navigation-types.js';
import { buildSidebar, getDefaultRoute } from './sidebar-builder.js';
import { recommendActions } from './dashboard-actions.js';

export function buildNavigationState(status: SystemStatus): NavigationState {
  return {
    sidebar: buildSidebar(status),
    dashboardActions: recommendActions(status),
    defaultRoute: getDefaultRoute(status.onboardingComplete),
  };
}
