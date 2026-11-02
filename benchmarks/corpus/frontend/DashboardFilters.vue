<template>
  <form aria-label="Dashboard filters" @submit.prevent="applyFilters">
    <label>Region <select v-model="selectedRegion"><option value="all">All regions</option></select></label>
    <button :disabled="loading">Apply</button>
    <p v-if="error" role="alert">{{ error }}</p>
  </form>
</template>

<script setup lang="ts">
import {ref} from 'vue';
const emit = defineEmits(['change']);
const selectedRegion = ref('all');
const loading = ref(false);
const error = ref('');

async function applyFilters() {
  loading.value = true;
  error.value = '';
  try { emit('change', {region: selectedRegion.value}); }
  catch { error.value = 'Could not apply filters'; }
  finally { loading.value = false; }
}
</script>

<style scoped>
form { display: flex; gap: 1rem; align-items: center; }
[role="alert"] { color: #b91c1c; }
</style>
