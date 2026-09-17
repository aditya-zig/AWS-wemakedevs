import { createHash } from 'node:crypto';
import type { Experiment, ExperimentType, Requirement, ToolName } from '../../contracts/src/index.js';

function shortHash(value: string): string {
  return createHash('sha256').update(value.trim().toLowerCase()).digest('hex').slice(0, 10).toUpperCase();
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

export function parseRequirements(input: readonly string[]): Requirement[] {
  return input.map((raw) => {
    const text = raw.trim();
    const lower = text.toLowerCase();
    const experimentTypes: ExperimentType[] = [];
    const targetTools: ToolName[] = [];
    const invariants: string[] = [text];

    if (/api|endpoint|health|http|graphql|websocket/.test(lower)) {
      experimentTypes.push('api');
      targetTools.push('api');
      invariants.push('The requested API behavior remains observable from an executed request.');
    }

    if (/payment|provider|unavailable|latency|timeout|network|dependency|outage|crash/.test(lower)) {
      experimentTypes.push('chaos');
      targetTools.push('chaos');
      invariants.push('The product remains in a recoverable state when the dependency is degraded.');
    }

    if (/cart/.test(lower)) invariants.push('The user cart must be preserved across the failure path.');

    if (/auth|authentication|authorization|permission|expired|protected|security/.test(lower)) {
      experimentTypes.push('security');
      targetTools.push('security');
      invariants.push('Unauthorized or expired credentials must not grant protected access.');
    }

    if (/browser|checkout|user|screen|ui|form|button|flow/.test(lower)) {
      experimentTypes.push('browser');
      targetTools.push('desktop');
    }

    if (/performance|latency|throughput|load|concurrent|response time/.test(lower)) {
      experimentTypes.push('performance');
      targetTools.push('performance');
    }

    if (/customer|persona|many users|simulation/.test(lower)) {
      experimentTypes.push('customer');
      targetTools.push('customer');
    }

    if (experimentTypes.length === 0) {
      experimentTypes.push('browser', 'api');
      targetTools.push('desktop', 'api');
    } else if (!experimentTypes.includes('browser') && !experimentTypes.includes('api')) {
      // Always include one deterministic baseline before adversarial verification.
      experimentTypes.unshift('api');
      targetTools.unshift('api');
    }

    return {
      id: `REQ-${shortHash(text)}`,
      text,
      invariants: unique(invariants),
      experimentTypes: unique(experimentTypes),
      targetTools: unique(targetTools),
    };
  });
}

const TOOL_FOR_TYPE: Record<ExperimentType, ToolName> = {
  browser: 'desktop',
  api: 'api',
  security: 'security',
  performance: 'performance',
  chaos: 'chaos',
  customer: 'customer',
};

export function buildVerificationPlan(requirements: readonly Requirement[]): Experiment[] {
  const plan: Experiment[] = [];
  for (const requirement of requirements) {
    for (const type of requirement.experimentTypes) {
      plan.push({
        id: `EXP-${shortHash(`${requirement.id}:${type}`)}`,
        requirementId: requirement.id,
        type,
        tool: TOOL_FOR_TYPE[type],
        description: `${type} verification for: ${requirement.text}`,
        status: 'pending',
        attempts: 0,
        evidenceIds: [],
      });
    }
  }
  return plan;
}
