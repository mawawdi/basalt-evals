import type { StudioCollectionPlan } from "../../contracts/src/index.js";

export const NATIVE_STARTUP_ATTEMPTS = 4;

export function nativeLaunchWork(plan: StudioCollectionPlan, sessions: number) {
  if (!Number.isSafeInteger(sessions) || sessions < 0)
    throw new Error("Invalid native session count");
  const rootLaunches = sessions * (plan.scenarios.length + 1);
  const clientLaunches = sessions * plan.scenarios.length * plan.clients;
  return {
    capturePasses: sessions,
    nativeRootLaunches: rootLaunches,
    nativeClientLaunches: clientLaunches,
    startupRecoveryRootLaunches: rootLaunches * (NATIVE_STARTUP_ATTEMPTS - 1),
    startupRecoveryClientLaunches: clientLaunches * (NATIVE_STARTUP_ATTEMPTS - 1),
  };
}

export function combineNativeWork(...items: ReturnType<typeof nativeLaunchWork>[]) {
  return items.reduce(
    (sum, item) => ({
      capturePasses: sum.capturePasses + item.capturePasses,
      nativeRootLaunches: sum.nativeRootLaunches + item.nativeRootLaunches,
      nativeClientLaunches: sum.nativeClientLaunches + item.nativeClientLaunches,
      startupRecoveryRootLaunches:
        sum.startupRecoveryRootLaunches + item.startupRecoveryRootLaunches,
      startupRecoveryClientLaunches:
        sum.startupRecoveryClientLaunches + item.startupRecoveryClientLaunches,
    }),
    {
      capturePasses: 0,
      nativeRootLaunches: 0,
      nativeClientLaunches: 0,
      startupRecoveryRootLaunches: 0,
      startupRecoveryClientLaunches: 0,
    },
  );
}
