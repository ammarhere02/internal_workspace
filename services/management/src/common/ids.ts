import { ulid } from 'ulid';

/** Prefixed ULIDs: readable in logs, time-ordered (so sorting by _id is creation order), no ObjectId juggling. */
export const newId = (prefix: 'ws' | 'usr' | 'team' | 'prj' | 'brd' | 'wi' | 'col' | 'cmd') => `${prefix}_${ulid()}`;
