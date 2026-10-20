import type { StartupPhase } from "./store-registry-types.ts";

export const STARTUP_PHASES: readonly StartupPhase[] = Object.freeze([
  "desktop_bootstrap",
  "home_guard",
  "epoch_read_preflight",
  "epoch_transition",
  "post_epoch_pre_bind",
  "transport_bind",
  "first_run_seed",
  "identity_seed",
  "engine_construct",
  "engine_init_legacy_migrations",
  "runtime_ready",
]);

export const FUTURE_EPOCH_COORDINATOR_PHASE: StartupPhase = "epoch_transition";

export function startupPhaseIndex(phase: StartupPhase): number {
  const index = STARTUP_PHASES.indexOf(phase);
  if (index === -1) throw new Error(`unknown startup phase: ${phase}`);
  return index;
}

export function phasePrecedes(left: StartupPhase, right: StartupPhase): boolean {
  return startupPhaseIndex(left) < startupPhaseIndex(right);
}
