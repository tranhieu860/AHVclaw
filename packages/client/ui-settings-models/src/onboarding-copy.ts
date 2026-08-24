/** Durable settings namespace for product-wide GUI onboarding facts. */
export const WELCOME_NOTICE_SETTINGS_NAMESPACE = 'ui-onboarding'

/** Field storing the last welcome notice version the user acknowledged. */
export const WELCOME_NOTICE_ACK_FIELD = 'welcomeNoticeVersion'

/**
 * Bump only when the notice changes materially and every user should see it
 * again. The acknowledgement is compared for exact equality.
 */
export const WELCOME_NOTICE_VERSION = '2026-08-13.1'

/** The complete editable internal-testing notice in both supported GUI locales. */
export const WELCOME_NOTICE_COPY = {
  zh: {
    title: '关于 AHV Harness',
    body: 'AHV Harness 是在 DeepSeek Harness 之上构建的中文与越南语工作环境，由 AHV 团队维护。\n\n会话、令牌与插件都保存在当前用户的主目录中；换用户运行会打开另一份数据。遇到问题请联系管理员。',
    continueLabel: '继续',
  },
  en: {
    title: 'About AHV Harness',
    body: 'AHV Harness is a working environment built on DeepSeek Harness and maintained by the AHV team.\n\nSessions, credentials and plugins live in the home directory of the user this runs as, so running it as a different user opens a different set. Ask your administrator if something looks missing.',
    continueLabel: 'Continue',
  },
} as const
