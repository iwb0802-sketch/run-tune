import app from '../packages/web/src/api/index';

export default async function handler(req: Request) {
  return app.fetch(req);
}

export const config = {
  runtime: 'edge',
};
