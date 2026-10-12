// Validation of control requests (POST /api/control) before they are forwarded to the engine.
import { z } from 'zod';
import type { ControlAction, ControlRequest } from '../shared/types';

/** Exhaustive list of actions (compile error if types.ts gains an action that is missing here). */
const ACTIONS: Record<ControlAction, true> = {
  'session.start': true,
  'session.stop': true,
  'speedtest.run': true,
  'traceroute.run': true,
  'mtr.run': true,
  'mtu.run': true,
  'stun.run': true,
  'udpburst.run': true,
  'router.poll': true,
  'router.login': true,
  'router.setPassword': true,
  'eventlog.import': true,
  'config.reload': true,
};

export const CONTROL_ACTIONS = Object.keys(ACTIONS) as [ControlAction, ...ControlAction[]];

const paramsSchemas: Partial<Record<ControlAction, z.ZodType>> = {
  'session.start': z.object({
    durationMin: z.number().int().min(1).max(60 * 24 * 60).nullable().optional(),
    label: z.string().max(100).nullable().optional(),
  }),
  'traceroute.run': z.object({ family: z.union([z.literal(4), z.literal(6)]).optional() }),
  'router.setPassword': z.object({ password: z.string().max(128).nullable() }),
  'eventlog.import': z.object({ days: z.number().int().min(0).max(3650) }),
};

export const controlRequestSchema = z
  .object({
    action: z.enum(CONTROL_ACTIONS),
    params: z.record(z.string(), z.unknown()).optional(),
  })
  .superRefine((req, ctx) => {
    const schema = paramsSchemas[req.action];
    if (!schema) return;
    const res = schema.safeParse(req.params ?? {});
    if (!res.success) {
      for (const issue of res.error.issues) {
        ctx.addIssue({ code: 'custom', path: ['params', ...issue.path.map((p) => (typeof p === 'symbol' ? String(p) : p))], message: issue.message });
      }
    }
  });

/** Engine timeout per action (long-running tasks answer immediately with { started: true }). */
export function controlTimeoutMs(action: ControlAction): number {
  switch (action) {
    case 'router.setPassword':
      return 30_000; // DPAPI via the PowerShell worker
    case 'eventlog.import':
      return 60_000;
    default:
      return 15_000;
  }
}

export function toControlRequest(v: z.output<typeof controlRequestSchema>): ControlRequest {
  return v.params === undefined ? { action: v.action } : { action: v.action, params: v.params };
}
