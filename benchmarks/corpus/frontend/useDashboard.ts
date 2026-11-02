import {computed, ref, watch} from 'vue';

export function useDashboard(api: any) {
  const filters = ref({region: 'all', period: 'month'});
  const metrics = ref<any[]>([]);
  let pending: AbortController | undefined;

  async function reloadMetrics() {
    // Cancel an older response so rapid filter changes cannot overwrite fresh charts.
    pending?.abort();
    pending = new AbortController();
    metrics.value = await api.metrics(filters.value, {signal: pending.signal});
  }

  function updateDashboardFilters(patch: Partial<typeof filters.value>) {
    filters.value = {...filters.value, ...patch};
  }

  const revenueTotal = computed(() => metrics.value.reduce((sum, item) => sum + item.revenue, 0));
  watch(filters, reloadMetrics, {deep: true});
  return {filters, metrics, revenueTotal, reloadMetrics, updateDashboardFilters};
}
