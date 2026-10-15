import { normalizePath } from '../../../shared/lib'

export function buildStorageKey(folder: string, name: string): string {
  return normalizePath(`${folder}/${name}`)
}
