/**
 * Procedural memory as a tool: the model reads, writes and refines its own
 * skills (see src/skills/ for the storage and the auto-creation heuristics).
 *
 * One tool with an action, like `memory`: six separate tool names would cost six
 * chances for the model to forget the capability exists. The write actions are
 * `sequential` because save/improve are read-modify-write on a file and two of
 * them in the same batch could drop a version bump.
 *
 * The interesting action is `suggest`. A model that has to notice on its own
 * that "this task was worth saving" never does — the moment passes and the next
 * run relearns the same procedure. So after a complex, novel task the model
 * hands over the transcript and gets a yes/no plus a ready-made draft. Saving
 * stays an explicit second call: learning must never be a side effect.
 */
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import { log } from '../log.js';
import { type Embedder, hybridRank } from '../memory/semantic.js';
import { decideToSave } from '../skills/autocreate.js';
import { type SkillStore, scoreSkill } from '../skills/store.js';

export const SKILLS_TOOL_NAME = 'skills';

const SkillsParams = Type.Object({
  action: Type.Union([
    Type.Literal('list'),
    Type.Literal('read'),
    Type.Literal('save'),
    Type.Literal('improve'),
    Type.Literal('search'),
    Type.Literal('suggest'),
  ]),
  id: Type.Optional(
    Type.String({
      description: 'For read and improve: the skill id (the slug of its name, see list).',
    }),
  ),
  name: Type.Optional(
    Type.String({
      description:
        'For save: short human name. The id is derived from it, and saving again with the same name updates that skill.',
    }),
  ),
  description: Type.Optional(
    Type.String({
      description: 'For save: one line saying what the skill accomplishes.',
    }),
  ),
  category: Type.Optional(
    Type.String({
      description:
        'For save: grouping like "sistema", "navegación", "escritorio". Defaults to "general".',
    }),
  ),
  whenToUse: Type.Optional(
    Type.String({
      description:
        'For save: the request or situation that should trigger this skill. Phrase it as the user would ask.',
    }),
  ),
  steps: Type.Optional(
    Type.Array(
      Type.String({
        description: 'For save: one imperative line per step, in the order that worked.',
      }),
    ),
  ),
  newSteps: Type.Optional(
    Type.Array(
      Type.String({
        description: 'For improve: the complete new step list, replacing the old one.',
      }),
    ),
  ),
  reason: Type.Optional(
    Type.String({
      description: 'For improve: why the steps change. Kept in ## Notes next to what was removed.',
    }),
  ),
  query: Type.Optional(
    Type.String({
      description: 'For search: words to match against name, description and whenToUse.',
    }),
  ),
  transcript: Type.Optional(
    Type.String({
      description: 'For suggest: the transcript of the task just finished, tool calls included.',
    }),
  ),
  result: Type.Optional(
    Type.String({
      description:
        'For suggest: the final outcome text of the task, so failures are not learned from.',
    }),
  ),
});

export interface SkillsToolDeps {
  store: SkillStore;
  /** S5: present only when PA_SEMANTIC_RECALL=1; failures fall back to lexical. */
  semantic?: Embedder;
}

export function createSkillsTool(deps: SkillsToolDeps): AgentTool<typeof SkillsParams> {
  const { store, semantic } = deps;
  return {
    name: SKILLS_TOOL_NAME,
    label: 'Skills',
    description: [
      'Procedural memory: reusable recipes ("skills") for how to do a kind of task, each one a',
      'SKILL.md file the user can read and edit. Episodic memory says what is true about the',
      'user; a skill says how something was done successfully before.',
      '',
      'action=list shows every skill (id, name, when to use). Call it before a task that',
      'sounds like something already solved once, then action=read the matching one and',
      'follow its steps.',
      'action=search finds skills by words from the user request.',
      'action=save stores a new skill, or updates the skill with the same name (the version',
      'goes up). One imperative line per step, in the real working order.',
      'action=improve replaces the steps of an existing skill and records the reason and the',
      'removed steps in its notes. Only improve from real experience.',
      'action=suggest analyses a transcript of the task you just finished and answers whether',
      'it deserves to become a skill, with a draft ready to save. Call suggest right after a',
      'complex, novel task succeeded (several different tools, an outcome the user may ask',
      'for again); if it reports worth=true, follow with action=save using its draft.',
    ].join('\n'),
    parameters: SkillsParams,
    executionMode: 'sequential',
    execute: async (_id, args) => {
      switch (args.action) {
        case 'list': {
          const skills = store.list();
          if (skills.length === 0) {
            return {
              content: [{ type: 'text', text: 'Todavía no hay ningún skill guardado.' }],
              details: { count: 0, ids: [] },
            };
          }
          return {
            content: [
              {
                type: 'text',
                text: skills
                  .map(
                    (skill) =>
                      `- ${skill.id} (v${skill.version}): ${skill.name} -> ${skill.whenToUse}`,
                  )
                  .join('\n'),
              },
            ],
            details: { count: skills.length, ids: skills.map((skill) => skill.id) },
          };
        }

        case 'read': {
          const id = String(args.id ?? '').trim();
          if (!id) throw new Error('la acción read necesita id');
          const skill = store.read(id);
          if (!skill) {
            return {
              content: [{ type: 'text', text: `No hay ningún skill con id ${id}.` }],
              details: { id, found: false },
            };
          }
          return {
            content: [{ type: 'text', text: store.export(id) }],
            details: { id, found: true, name: skill.name, version: skill.version },
          };
        }

        case 'save': {
          const name = String(args.name ?? '').trim();
          const description = String(args.description ?? '').trim();
          const whenToUse = String(args.whenToUse ?? '').trim();
          const steps = (args.steps ?? []).map((step) => String(step).trim()).filter(Boolean);
          if (!name || !description || !whenToUse || steps.length === 0) {
            throw new Error('la acción save necesita name, description, whenToUse y steps');
          }
          const id = store.save({
            name,
            description,
            category: String(args.category ?? '').trim(),
            whenToUse,
            steps,
          });
          return {
            content: [
              { type: 'text', text: `Skill guardado: ${id} (v${store.read(id)?.version ?? 1}).` },
            ],
            details: { id, version: store.read(id)?.version ?? 1 },
          };
        }

        case 'improve': {
          const id = String(args.id ?? '').trim();
          const reason = String(args.reason ?? '').trim();
          const newSteps = (args.newSteps ?? []).map((step) => String(step).trim()).filter(Boolean);
          if (!id || !reason || newSteps.length === 0) {
            throw new Error('la acción improve necesita id, newSteps y reason');
          }
          store.improve(id, newSteps, reason);
          return {
            content: [
              {
                type: 'text',
                text: `Skill ${id} mejorado a v${store.read(id)?.version ?? 1}. El motivo y los pasos retirados quedan en ## Notes.`,
              },
            ],
            details: { id, version: store.read(id)?.version ?? 1, steps: newSteps },
          };
        }

        case 'search': {
          const query = String(args.query ?? '').trim();
          if (!query) throw new Error('la acción search necesita query');
          let hits = store.search(query);
          if (semantic) {
            // S5: semantic re-rank catches paraphrases the lexical scorer misses.
            try {
              hits = await hybridRank({
                query,
                items: store.list(),
                text: (s) => `${s.name} ${s.description} ${s.whenToUse} ${s.category}`,
                lexical: scoreSkill,
                embedder: semantic,
                limit: 10,
              });
            } catch (err) {
              log.warn('semantic skill search unavailable, lexical fallback', { err: String(err) });
            }
          }
          if (hits.length === 0) {
            return {
              content: [{ type: 'text', text: 'Ningún skill coincide con esa búsqueda.' }],
              details: { count: 0, ids: [] },
            };
          }
          return {
            content: [
              {
                type: 'text',
                text: hits.map((skill) => `- ${skill.id}: ${skill.description}`).join('\n'),
              },
            ],
            details: { count: hits.length, ids: hits.map((skill) => skill.id) },
          };
        }

        case 'suggest': {
          const transcript = String(args.transcript ?? '').trim();
          const result = String(args.result ?? '').trim();
          if (!transcript) throw new Error('la acción suggest necesita transcript');
          const decision = decideToSave(transcript, result, store.list());
          const lines = [decision.reason];
          const draft = decision.draft;
          if (draft) {
            lines.push(
              '',
              'Propuesta:',
              `name: ${draft.name}`,
              `description: ${draft.description}`,
              `category: ${draft.category}`,
              `whenToUse: ${draft.whenToUse}`,
              `steps: ${draft.steps.join(' | ')}`,
              '',
              'Si te parece bien, guárdala con action=save y estos mismos campos.',
            );
          }
          return {
            content: [{ type: 'text', text: lines.join('\n') }],
            details: { worth: decision.worth, reason: decision.reason, draft: draft ?? null },
          };
        }

        default:
          throw new Error(`acción desconocida: ${String(args.action)}`);
      }
    },
  };
}
