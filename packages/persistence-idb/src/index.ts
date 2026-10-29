export { PERSISTENCE_ERROR_CODES, type PersistenceErrorCode, type StoreFailure } from './codes.js';
export {
  DATABASE_VERSION,
  DEFAULT_DATABASE_NAME,
  DEFAULT_KEY,
  OBJECT_STORE_NAME,
  openDocumentStore,
  type ClearResult,
  type DocumentStore,
  type DocumentStoreOptions,
  type OpenResult,
  type ReadResult,
  type WriteResult,
} from './store.js';
export {
  createAutosave,
  DEFAULT_DELAY_MS,
  DEFAULT_MAX_WAIT_MS,
  type Autosave,
  type AutosaveOptions,
  type AutosaveTimers,
} from './autosave.js';
