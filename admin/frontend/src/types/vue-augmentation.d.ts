import 'vue'

declare module 'vue' {
  interface ComponentInternalInstance {
    proxy: any
  }
}
