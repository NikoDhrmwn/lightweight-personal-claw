import { existsSync, readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

export interface PreconfiguredWorld {
  id: string;
  name: string;
  tagline: string;
  description: string;
  lorePath: string;
  pdfPath: string;
}

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const WORLD_ROOT = resolve(MODULE_DIR, '..', '..', 'brain', 'preconfigured-worlds');

const PRECONFIGURED_WORLDS: PreconfiguredWorld[] = [
  {
    id: 'elyndor',
    name: 'The World of Elyndor',
    tagline: 'Ancient magic, rival empires, hungry ruins, and a continent on the edge of prophecy.',
    description: 'A dense high-fantasy setting built for long-form campaigns, faction play, contested borders, deep lore questions, and RAG-assisted scene generation.',
    lorePath: resolve(WORLD_ROOT, 'elyndor', 'elyndor_lorebook.md'),
    pdfPath: resolve(WORLD_ROOT, 'elyndor', 'Elyndor_Lorebook.pdf'),
  },
];

export const DEFAULT_PRECONFIGURED_WORLD_ID = PRECONFIGURED_WORLDS[0]?.id ?? 'elyndor';

export const PRECONFIGURED_WORLD_CHOICES = PRECONFIGURED_WORLDS.map(world => ({
  name: `📚 ${world.name}`,
  value: world.id,
}));

export function listPreconfiguredWorlds(): PreconfiguredWorld[] {
  return [...PRECONFIGURED_WORLDS];
}

export function getPreconfiguredWorld(worldId: string | null | undefined): PreconfiguredWorld | null {
  if (!worldId) return null;
  return PRECONFIGURED_WORLDS.find(world => world.id === worldId) ?? null;
}

export function readPreconfiguredWorldLore(world: PreconfiguredWorld): string {
  return readRequiredUtf8(world.lorePath, `${world.name} lore source`);
}

function readRequiredUtf8(filePath: string, label: string): string {
  if (!existsSync(filePath)) {
    throw new Error(`${label} not found at ${filePath}`);
  }
  return readFileSync(filePath, 'utf-8');
}
