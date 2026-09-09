import { defineConfig, loadEnv } from 'vite'
import path from 'path'
import createVitePlugins from './vite/plugins'

const baseUrl = 'http://127.0.0.1:8080' // 本机若依后端接口
const workbenchUrl = 'http://127.0.0.1:8002' // 仅供若依页面反向代理的本机作图前端
const portalUrl = 'http://127.0.0.1:8003' // 仅供用户端门户反向代理的本机 React 前端

// https://vitejs.dev/config/
export default defineConfig(({ mode, command }) => {
  const env = loadEnv(mode, process.cwd())
  const { VITE_APP_ENV } = env
  return {
    // 部署生产环境和开发环境下的URL。
    // 默认情况下，vite 会假设你的应用是被部署在一个域名的根路径上
    // 例如 https://www.ruoyi.vip/。如果应用被部署在一个子路径上，你就需要用这个选项指定这个子路径。例如，如果你的应用被部署在 https://www.ruoyi.vip/admin/，则设置 baseUrl 为 /admin/。
    base: VITE_APP_ENV === 'production' ? '/' : '/',
    plugins: createVitePlugins(env, command === 'build'),
    resolve: {
      // https://cn.vitejs.dev/config/#resolve-alias
      alias: {
        // 设置路径
        '~': path.resolve(__dirname, './'),
        // 设置别名
        '@': path.resolve(__dirname, './src')
      },
      // https://cn.vitejs.dev/config/#resolve-extensions
      extensions: ['.mjs', '.js', '.ts', '.jsx', '.tsx', '.json', '.vue']
    },
    // 打包配置
    build: {
      // https://vite.dev/config/build-options.html
      sourcemap: command === 'build' ? false : 'inline',
      outDir: 'dist',
      assetsDir: 'assets',
      chunkSizeWarningLimit: 2000,
      rollupOptions: {
        output: {
          chunkFileNames: 'static/js/[name]-[hash].js',
          entryFileNames: 'static/js/[name]-[hash].js',
          assetFileNames: 'static/[ext]/[name]-[hash].[ext]'
        }
      }
    },
    // vite 相关配置
    server: {
      // 8001 是用户唯一需要在浏览器访问的本机入口。其余端口都只在
      // 回环地址上作为内部组件使用，不能当成用户访问地址。
      port: 8001,
      host: '127.0.0.1',
      open: false,
      proxy: {
        // https://cn.vitejs.dev/config/#server-proxy
        '/dev-api': {
          target: baseUrl,
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/dev-api/, '')
        },
        // 作图工作台仍由独立的 React 前端渲染，但始终经当前若依域名
        // 打开。这样 Admin-Token cookie 可由下方的受控后端桥接验证，
        // 浏览器不需要也不会接触 Node 的内部令牌。
        '/workbench': {
          target: workbenchUrl,
          changeOrigin: true,
          ws: true
        },
        '/portal-auth': {
          target: baseUrl,
          changeOrigin: true
        },
        '/portal-api': {
          target: baseUrl,
          changeOrigin: true
        },
        // Chrome 可在浏览器侧拦截包含 /portal-api/outputs/ 的图片请求，
        // 此别名让浏览器只请求无业务语义的同源媒体地址，再由 Vite 在
        // 本机转发到仍受 Java 门户鉴权保护的真实资源地址。
        '/portal-media': {
          target: baseUrl,
          changeOrigin: true,
          rewrite: (p) => p
            .replace(/^\/portal-media\/o\//, '/portal-api/outputs/')
            .replace(/^\/portal-media\/e\//, '/portal-api/example-assets/')
        },
        // 自助用户端和管理后台属于不同权限边界。门户始终经 8001
        // 访问，8003 只在回环地址上渲染 React 页面。这个规则必须放
        // 在门户 API 规则之后，避免 /portal-api 被页面代理截获。
        '/portal': {
          target: portalUrl,
          changeOrigin: true,
          ws: true
        },
        '/captchaImage': {
          target: baseUrl,
          changeOrigin: true
        },
        '/health': {
          target: baseUrl,
          changeOrigin: true,
          rewrite: (p) => '/workbench-api' + p
        },
        '/api': {
          target: baseUrl,
          changeOrigin: true,
          rewrite: (p) => '/workbench-api' + p
        },
        '/outputs': {
          target: baseUrl,
          changeOrigin: true,
          rewrite: (p) => '/workbench-api' + p
        },
        '/example-assets': {
          target: baseUrl,
          changeOrigin: true,
          rewrite: (p) => '/workbench-api' + p
        },
         // springdoc proxy
         '^/v3/api-docs/(.*)': {
          target: baseUrl,
          changeOrigin: true,
        }
      }
    },
    css: {
      postcss: {
        plugins: [
          {
            postcssPlugin: 'internal:charset-removal',
            AtRule: {
              charset: (atRule: any) => {
                if (atRule.name === 'charset') {
                  atRule.remove()
                }
              }
            }
          }
        ]
      }
    }
  }
})

