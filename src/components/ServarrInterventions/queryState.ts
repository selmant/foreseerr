export const parseInterventionState = (search: string) => {
  const params = new URLSearchParams(search);
  const page = Number(params.get('page'));
  return {
    mode:
      params.get('mode') === 'history'
        ? ('history' as const)
        : ('active' as const),
    serviceType: ['radarr', 'sonarr'].includes(params.get('serviceType') ?? '')
      ? params.get('serviceType')!
      : '',
    mediaType: ['movie', 'tv'].includes(params.get('mediaType') ?? '')
      ? params.get('mediaType')!
      : '',
    page: Number.isSafeInteger(page) && page > 0 ? page - 1 : 0,
  };
};

export type InterventionState = ReturnType<typeof parseInterventionState>;

export const updateInterventionSearch = (
  search: string,
  changes: Partial<InterventionState>
) => {
  const state = { ...parseInterventionState(search), ...changes };
  if (
    changes.mode !== undefined ||
    changes.serviceType !== undefined ||
    changes.mediaType !== undefined
  )
    state.page = 0;
  const params = new URLSearchParams(search);
  const values = {
    mode: state.mode === 'active' ? '' : state.mode,
    serviceType: state.serviceType,
    mediaType: state.mediaType,
    page: state.page > 0 ? String(state.page + 1) : '',
  };
  for (const [key, value] of Object.entries(values)) {
    if (value) params.set(key, value);
    else params.delete(key);
  }
  return params;
};
