import { createApiApp } from './bootstrap/api';
import { loadConfig } from './shared/infrastructure/config';

const config = loadConfig();
const app = await createApiApp(config);
await app.listen(config.HTTP_PORT, '0.0.0.0');
