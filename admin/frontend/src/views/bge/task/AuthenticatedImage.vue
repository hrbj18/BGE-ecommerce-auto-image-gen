<template>
  <div class="authenticated-image" :class="{ 'is-loading': loading }">
    <el-image
      v-if="objectUrl"
      :src="objectUrl"
      :alt="props.alt || '已鉴权成品图'"
      :preview-src-list="[objectUrl]"
      :initial-index="0"
      fit="cover"
      preview-teleported
      hide-on-click-modal
    />
    <div v-else-if="loading" class="image-state">
      <el-icon class="is-loading"><Loading /></el-icon>
      <span>正在读取</span>
    </div>
    <div v-else class="image-state image-error">
      <el-icon><Picture /></el-icon>
      <span>{{ errorMessage || '暂无预览' }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { getBgeAsset } from '../../../api/bge/task'

const props = defineProps<{
  src: string
  alt?: string
}>()

const loading = ref(false)
const objectUrl = ref('')
const errorMessage = ref('')
let activeController: AbortController | null = null

function releaseObjectUrl() {
  if (objectUrl.value) {
    URL.revokeObjectURL(objectUrl.value)
    objectUrl.value = ''
  }
}

async function loadImage() {
  activeController?.abort()
  activeController = null
  releaseObjectUrl()
  errorMessage.value = ''

  if (!props.src) return

  const controller = new AbortController()
  activeController = controller
  loading.value = true
  try {
    const blob = await getBgeAsset(props.src, controller.signal)
    if (controller.signal.aborted) return
    if (!blob.type.toLowerCase().startsWith('image/')) {
      throw new Error('服务端返回的内容不是图片。')
    }
    objectUrl.value = URL.createObjectURL(blob)
  } catch (error) {
    if (!controller.signal.aborted) {
      errorMessage.value = error instanceof Error ? error.message : '图片读取失败'
    }
  } finally {
    if (activeController === controller) {
      activeController = null
      loading.value = false
    }
  }
}

watch(() => props.src, loadImage, { immediate: true })

onBeforeUnmount(() => {
  activeController?.abort()
  activeController = null
  releaseObjectUrl()
})
</script>

<style scoped lang="scss">
.authenticated-image {
  width: 100%;
  aspect-ratio: 1 / 1;
  overflow: hidden;
  border-radius: 8px;
  background: var(--el-fill-color-light);
  border: 1px solid var(--el-border-color-lighter);
}

.authenticated-image :deep(.el-image) {
  width: 100%;
  height: 100%;
}

.image-state {
  display: flex;
  width: 100%;
  height: 100%;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--el-text-color-secondary);
  font-size: 13px;
}

.image-error {
  padding: 12px;
  text-align: center;
  color: var(--el-text-color-placeholder);
}
</style>
