import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Evidence, Experiment, Finding } from '../../contracts/src/index.js';

export type EvidenceNodeType = 'requirement' | 'experiment' | 'evidence' | 'finding' | 'repair';
export type EvidenceEdgeType = 'verifies' | 'produced' | 'supports' | 'explains' | 'repairs' | 'reverifies';
export interface EvidenceNode { id: string; type: EvidenceNodeType; data?: unknown; }
export interface EvidenceEdge { from: string; to: string; type: EvidenceEdgeType; }
interface EvidenceGraphSnapshot { nodes: EvidenceNode[]; edges: EvidenceEdge[]; }

export class EvidenceGraph {
  readonly nodes: EvidenceNode[];
  readonly edges: EvidenceEdge[];
  #nodeIds: Set<string>;

  constructor(snapshot?: EvidenceGraphSnapshot) {
    this.nodes = snapshot?.nodes.map((node) => structuredClone(node)) ?? [];
    this.edges = snapshot?.edges.map((edge) => structuredClone(edge)) ?? [];
    this.#nodeIds = new Set(this.nodes.map((node) => node.id));
  }

  private node(id: string, type: EvidenceNodeType, data?: unknown): void {
    if (this.#nodeIds.has(id)) return;
    this.#nodeIds.add(id);
    this.nodes.push(data === undefined ? { id, type } : { id, type, data });
  }
  linkRequirement(requirementId: string): void { this.node(requirementId, 'requirement'); }
  linkExperiment(experiment: Experiment): void {
    this.node(experiment.requirementId, 'requirement');
    this.node(experiment.id, 'experiment', experiment);
    this.edges.push({ from: experiment.requirementId, to: experiment.id, type: 'verifies' });
  }
  addEvidence(evidence: Evidence): void {
    this.node(evidence.id, 'evidence', evidence);
    this.edges.push({ from: evidence.experimentId, to: evidence.id, type: 'produced' });
  }
  addFinding(finding: Finding): void {
    this.node(finding.id, 'finding', finding);
    for (const evidenceId of finding.evidenceIds) this.edges.push({ from: evidenceId, to: finding.id, type: 'supports' });
  }
}

export class JsonEvidenceGraphStore {
  constructor(private readonly filePath: string) {}

  async save(graph: EvidenceGraph): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.tmp`;
    await writeFile(temp, JSON.stringify({ nodes: graph.nodes, edges: graph.edges }, null, 2), { mode: 0o600 });
    await rename(temp, this.filePath);
  }

  async load(): Promise<EvidenceGraph> {
    const snapshot = JSON.parse(await readFile(this.filePath, 'utf8')) as EvidenceGraphSnapshot;
    return new EvidenceGraph(snapshot);
  }
}
