<script setup>
import { computed } from "vue";
import { RouterLink } from "vue-router";
import { useGameStats } from "../composables/useStore.js";

const props = defineProps({ game: { type: Object, required: true } });

const ready = computed(() => props.game.status === "ready");
const profile = useGameStats(props.game.id);
const best = computed(() => (ready.value ? profile.value.best : 0));
const plays = computed(() => (ready.value ? profile.value.plays : 0));
const style = computed(() => ({ "--card-accent": props.game.accent }));
</script>

<template>
  <component
    :is="ready ? RouterLink : 'div'"
    class="card"
    :class="{ 'card--soon': !ready }"
    :style="style"
    :to="ready ? { name: 'game', params: { id: game.id } } : undefined"
    :aria-disabled="!ready"
  >
    <span class="card-mark">{{ game.mark }}</span>
    <span class="card-body">
      <strong class="card-title">{{ game.name }}</strong>
      <p class="card-sub">{{ game.subtitle }}</p>
      <span class="card-tags">
        <span v-for="tag in game.tags" :key="tag" class="chip">{{ tag }}</span>
      </span>
      <span class="card-foot">
        <span v-if="ready" class="card-cta">开始游戏 →</span>
        <span v-else class="card-soon">敬请期待</span>
        <span v-if="ready && plays" class="card-best">最高 {{ best }} 分 · 累计 {{ plays }} 局</span>
      </span>
    </span>
  </component>
</template>

<style scoped>
.card {
  display: flex;
  gap: 14px;
  padding: 16px;
  border: 1px solid var(--panel-edge);
  border-radius: var(--radius);
  background: linear-gradient(160deg, rgba(74, 193, 255, 0.08), transparent 55%), var(--panel);
  color: inherit;
  text-decoration: none;
  transition: transform 0.12s ease, border-color 0.15s ease;
}

a.card:hover {
  transform: translateY(-2px);
  border-color: var(--card-accent);
}

a.card:focus-visible {
  outline: 2px solid var(--card-accent);
  outline-offset: 3px;
}

.card-mark {
  display: grid;
  place-items: center;
  flex: none;
  width: 62px;
  height: 62px;
  border-radius: 16px;
  background: linear-gradient(150deg, var(--card-accent), #123);
  color: #04101c;
  font-size: 26px;
  font-weight: 800;
}

.card-body {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.card-title {
  font-size: 18px;
  letter-spacing: 0.5px;
}

.card-sub {
  margin: 0;
  color: var(--text-muted);
  font-size: 13px;
}

.card-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.card-foot {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: auto;
  padding-top: 6px;
}

.card-cta {
  color: var(--card-accent);
  font-weight: 700;
  font-size: 14px;
}

.card-best {
  color: var(--text-muted);
  font-size: 12px;
}

.card--soon {
  border-style: dashed;
  background: var(--bg-soft);
  filter: saturate(0.5);
}

.card-soon {
  color: var(--warn);
  font-size: 13px;
  font-weight: 600;
}

html[data-device="phone"] .card-mark {
  width: 52px;
  height: 52px;
  font-size: 22px;
}
</style>
