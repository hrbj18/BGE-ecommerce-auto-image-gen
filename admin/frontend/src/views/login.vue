<template>
  <div class="login">
    <div class="login-shell">
      <div class="brand-lockup">
        <img :src="brandMark" alt="海客" class="brand-mark" />
        <div>
          <strong>海客电商生图</strong>
          <span>HAIKE COMMERCE AI</span>
        </div>
      </div>
      <el-form ref="loginRef" :model="loginForm" :rules="loginRules" class="login-form">
      <div class="login-heading">
        <h1>后台管理</h1>
        <p>{{ title }}</p>
      </div>
      <el-form-item prop="username">
        <el-input
          v-model="loginForm.username"
          type="text"
          size="large"
          auto-complete="off"
          placeholder="账号"
        >
          <template #prefix><svg-icon icon-class="user" class="el-input__icon input-icon" /></template>
        </el-input>
      </el-form-item>
      <el-form-item prop="password">
        <el-input
          v-model="loginForm.password"
          type="password"
          size="large"
          auto-complete="off"
          placeholder="密码"
          @keyup.enter="handleLogin"
        >
          <template #prefix><svg-icon icon-class="password" class="el-input__icon input-icon" /></template>
        </el-input>
      </el-form-item>
      <el-form-item prop="code" v-if="captchaEnabled">
        <el-input
          v-model="loginForm.code"
          size="large"
          auto-complete="off"
          placeholder="验证码"
          style="width: 63%"
          @keyup.enter="handleLogin"
        >
          <template #prefix><svg-icon icon-class="validCode" class="el-input__icon input-icon" /></template>
        </el-input>
        <div class="login-code">
          <img :src="codeUrl" @click="getCode" class="login-code-img"/>
        </div>
      </el-form-item>
      <el-checkbox v-model="loginForm.rememberMe" style="margin:0px 0px 25px 0px;">记住密码</el-checkbox>
      <el-form-item style="width:100%;">
        <el-button
          :loading="loading"
          size="large"
          type="primary"
          style="width:100%;"
          @click.prevent="handleLogin"
        >
          <span v-if="!loading">登 录</span>
          <span v-else>登 录 中...</span>
        </el-button>
        <div style="float: right;" v-if="register">
          <router-link class="link-type" :to="'/register'">立即注册</router-link>
        </div>
      </el-form-item>
      </el-form>
    </div>
    <!--  底部  -->
    <div class="el-login-footer">
      <span>{{ footerContent }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { getCodeImg } from "@/api/login"
import Cookies from "js-cookie"
import { encrypt, decrypt } from "@/utils/jsencrypt"
import useUserStore from '@/store/modules/user'
import defaultSettings from '@/settings'
import type { CaptchaInfoResult } from '@/types/api/login'
import type { LoginForm } from '@/types/api/login'
import brandMark from '@/assets/logo/haike-mark.svg'

const title = import.meta.env.VITE_APP_TITLE
const footerContent = defaultSettings.footerContent
const userStore = useUserStore()
const route = useRoute()
const router = useRouter()
const { proxy } = getCurrentInstance()

const loginForm = ref<LoginForm>({
  username: "admin",
  password: "",
  rememberMe: false,
  code: "",
  uuid: ""
})

const loginRules = {
  username: [{ required: true, trigger: "blur", message: "请输入您的账号" }],
  password: [{ required: true, trigger: "blur", message: "请输入您的密码" }],
  code: [{ required: true, trigger: "change", message: "请输入验证码" }]
}

const codeUrl = ref("")
const loading = ref(false)
// 验证码开关
const captchaEnabled = ref(true)
// 注册开关
const register = ref(false)
const redirect = ref<string | undefined>(undefined)

watch(route, (newRoute: any) => {
    redirect.value = (newRoute.query && newRoute.query.redirect) as string | undefined
}, { immediate: true })

function handleLogin(): void {
  proxy.$refs.loginRef.validate((valid: boolean) => {
    if (valid) {
      loading.value = true
      // 勾选了需要记住密码设置在 cookie 中设置记住用户名和密码
      if (loginForm.value.rememberMe) {
        Cookies.set("username", loginForm.value.username, { expires: 30 })
        Cookies.set("password", encrypt(loginForm.value.password), { expires: 30 })
        Cookies.set("rememberMe", loginForm.value.rememberMe, { expires: 30 })
      } else {
        // 否则移除
        Cookies.remove("username")
        Cookies.remove("password")
        Cookies.remove("rememberMe")
      }
      // 调用action的登录方法
      userStore.login(loginForm.value).then(() => {
        const query = route.query
        const otherQueryParams = Object.keys(query).reduce((acc: Record<string, any>, cur) => {
          if (cur !== "redirect") {
            acc[cur] = query[cur]
          }
          return acc
        }, {})
        router.push({ path: redirect.value || "/", query: otherQueryParams })
      }).catch(() => {
        loading.value = false
        // 重新获取验证码
        if (captchaEnabled.value) {
          getCode()
        }
      })
    }
  })
}

function getCode(): void {
  getCodeImg().then(res => {
    captchaEnabled.value = res.captchaEnabled === undefined ? true : res.captchaEnabled
    if (captchaEnabled.value) {
      codeUrl.value = "data:image/gif;base64," + res.img
      loginForm.value.uuid = res.uuid
    }
  })
}

function getCookie(): void {
  const username = Cookies.get("username")
  const password = Cookies.get("password")
  const rememberMe = Cookies.get("rememberMe")
  loginForm.value = {
    username: username === undefined ? loginForm.value.username : username,
    password: password === undefined ? loginForm.value.password : decrypt(password),
    rememberMe: rememberMe === undefined ? false : Boolean(rememberMe)
  }
}

getCode()
getCookie()
</script>

<style lang='scss' scoped>
.login {
  display: flex;
  justify-content: center;
  align-items: center;
  min-height: 620px;
  height: 100%;
  padding: 32px 20px;
  box-sizing: border-box;
  background: #eef3f1;
  position: relative;
  overflow: hidden;

  &::before,
  &::after {
    content: "";
    position: absolute;
    left: 0;
    right: 0;
    pointer-events: none;
  }

  &::before {
    top: 0;
    height: 34%;
    background: #132824;
  }

  &::after {
    top: 34%;
    height: 4px;
    background: #2aa899;
  }
}

.login-shell {
  width: min(420px, 100%);
  position: relative;
  z-index: 1;
}

.brand-lockup {
  display: flex;
  align-items: center;
  gap: 13px;
  margin: 0 0 18px 4px;
  color: #fff;

  .brand-mark {
    width: 44px;
    height: 44px;
    border-radius: 8px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.24);
  }

  strong,
  span {
    display: block;
    letter-spacing: 0;
  }

  strong {
    font-size: 20px;
    line-height: 26px;
  }

  span {
    margin-top: 1px;
    color: #a9c9c3;
    font-size: 11px;
    line-height: 16px;
  }
}

.login-heading {
  margin-bottom: 26px;

  h1 {
    margin: 0;
    color: #18231f;
    font-size: 24px;
    line-height: 32px;
    letter-spacing: 0;
  }

  p {
    margin: 5px 0 0;
    color: #7a8581;
    font-size: 13px;
    line-height: 20px;
  }
}

.login-form {
  border-radius: 8px;
  background: #ffffff;
  width: 100%;
  padding: 32px 32px 12px;
  box-sizing: border-box;
  border: 1px solid #dfe8e4;
  box-shadow: 0 18px 50px rgba(19, 40, 36, 0.16);

  .el-input {
    height: 44px;

    input {
      height: 44px;
    }
  }

  .input-icon {
    height: 43px;
    width: 14px;
    margin-left: 0;
  }
}

.login-code {
  width: 33%;
  height: 44px;
  float: right;

  img {
    cursor: pointer;
    vertical-align: middle;
  }
}
.el-login-footer {
  height: 40px;
  line-height: 40px;
  position: fixed;
  bottom: 0;
  width: 100%;
  text-align: center;
  color: #6f7c77;
  font-family: Arial;
  font-size: 12px;
  letter-spacing: 0;
}

.login-code-img {
  height: 44px;
  padding-left: 12px;
}

html.dark .login {
  background: #101714;

  &::before {
    background: #09110f;
  }

  .login-form {
    background: var(--el-bg-color-overlay) !important;
    border-color: #32413d;
    box-shadow: 0 18px 50px rgba(0, 0, 0, 0.5);
  }

  .login-heading h1 {
    color: var(--el-text-color-primary);
  }

  .el-login-footer {
    color: #8d9b96;
  }
}

@media (max-width: 520px) {
  .login {
    align-items: flex-start;
    min-height: 100%;
    padding-top: 56px;
  }

  .login-form {
    padding: 28px 22px 10px;
  }
}
</style>
