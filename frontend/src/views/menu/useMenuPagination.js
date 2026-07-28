import { computed, ref, watch } from 'vue'

export function useMenuPagination(source, defaultPageSize = 10) {
  const currentPage = ref(1)
  const pageSize = ref(defaultPageSize)
  const totalItems = computed(() => source.value.length)
  const paginatedItems = computed(() => {
    const start = (currentPage.value - 1) * pageSize.value
    return source.value.slice(start, start + pageSize.value)
  })

  watch(source, () => {
    currentPage.value = 1
  })
  watch(pageSize, () => {
    currentPage.value = 1
  })

  return { currentPage, pageSize, totalItems, paginatedItems }
}
