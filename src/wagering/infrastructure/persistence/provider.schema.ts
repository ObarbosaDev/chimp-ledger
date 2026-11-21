import { EntitySchema } from '@mikro-orm/core';

export interface ProviderRecord {
  id: string;
  active: boolean;
  currencies: string[];
  createdAt: Date;
}

export const ProviderSchema = new EntitySchema<ProviderRecord>({
  name: 'ProviderRecord',
  tableName: 'providers',
  properties: {
    id: { type: 'string', primary: true },
    active: { type: 'boolean' },
    currencies: { type: 'string[]', columnType: 'char(3)[]' },
    createdAt: { type: 'Date', columnType: 'timestamptz' },
  },
});
