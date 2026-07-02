export function serviceDeskEnvironmentExpression({ quote = "'" } = {}) {
  const names = ['N8N_ENVIRONMENT', 'SERVICE_DESK_ENV', 'APP_ENV', 'ENVIRONMENT', 'NODE_ENV'];
  return names.map((name) => `envValue(${quote}${name}${quote})`).join(' || ');
}

export const SERVICE_DESK_ENVIRONMENT_ORDER = [
  'N8N_ENVIRONMENT',
  'SERVICE_DESK_ENV',
  'APP_ENV',
  'ENVIRONMENT',
  'NODE_ENV',
];
