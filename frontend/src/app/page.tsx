import Link from "next/link";
import {
  Bot,
  Globe,
  Code,
  Smartphone,
  Brain,
  Shield,
  Check,
  ArrowRight,
  Zap,
} from "lucide-react";

const features = [
  {
    icon: Bot,
    title: "Trò chuyện AI",
    description: "Trò chuyện với hơn 20 model AI bao gồm GPT, Claude, Gemini",
  },
  {
    icon: Globe,
    title: "Tự động hóa trình duyệt",
    description: "AI duyệt web, chụp ảnh màn hình, trích xuất dữ liệu",
  },
  {
    icon: Code,
    title: "Soạn thảo code & Terminal",
    description: "Soạn thảo code với Monaco, chạy lệnh trực tiếp",
  },
  {
    icon: Smartphone,
    title: "Đa kênh",
    description: "Kết nối bot Telegram, Zalo, Discord",
  },
  {
    icon: Brain,
    title: "Trí nhớ",
    description: "AI ghi nhớ sở thích và ngữ cảnh của bạn",
  },
  {
    icon: Shield,
    title: "Quản lý máy chủ",
    description: "SSH vào máy chủ, giám sát tình trạng, chạy lệnh",
  },
];

const pricingTiers = [
  {
    name: "Free",
    price: "$0",
    period: "/month",
    description: "Bắt đầu với các tính năng cơ bản",
    features: [
      "100 tin nhắn/ngày",
      "1 không gian làm việc",
      "5 model AI",
      "1GB lưu trữ",
      "Hỗ trợ cộng đồng",
    ],
    cta: "Dùng miễn phí",
    href: "/login?register=true",
    highlighted: false,
  },
  {
    name: "Pro",
    price: "$5",
    period: "/month",
    description: "Dành cho người dùng chuyên nghiệp",
    features: [
      "Tin nhắn không giới hạn",
      "5 không gian làm việc",
      "Tất cả model AI",
      "10GB lưu trữ",
      "Bot Telegram/Zalo/Discord",
      "Hỗ trợ ưu tiên",
    ],
    cta: "Nâng cấp Pro",
    href: "/login?register=true",
    highlighted: true,
  },
  {
    name: "Enterprise",
    price: "Custom",
    period: "",
    description: "Dành cho tổ chức quy mô lớn",
    features: [
      "Tất cả tính năng Pro",
      "Không gian làm việc không giới hạn",
      "Model AI tùy chỉnh",
      "Lưu trữ không giới hạn",
      "Hỗ trợ riêng",
      "Cam kết SLA",
    ],
    cta: "Liên hệ",
    href: "mailto:contact@ahvholding.com",
    highlighted: false,
  },
];

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-zinc-950 text-white">
      {/* Navigation */}
      <nav className="fixed top-0 z-50 w-full border-b border-zinc-800/50 bg-zinc-950/80 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-6">
          <Link href="/" className="flex items-center gap-2">
            <Zap className="h-6 w-6 text-blue-500" />
            <span className="text-xl font-bold">AHVclaw</span>
          </Link>
          <div className="flex items-center gap-4">
            <Link
              href="/login"
              className="rounded-lg px-4 py-2 text-sm text-zinc-400 transition-colors hover:text-white"
            >
              Đăng nhập
            </Link>
            <Link
              href="/login?register=true"
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-500"
            >
              Bắt đầu
            </Link>
          </div>
        </div>
      </nav>

      {/* Hero Section */}
      <section className="relative flex min-h-screen items-center justify-center overflow-hidden px-6 pt-16">
        {/* Gradient orb */}
        <div className="pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2">
          <div className="h-[600px] w-[600px] rounded-full bg-blue-500/20 blur-[128px]" />
        </div>
        <div className="pointer-events-none absolute top-1/3 right-1/4">
          <div className="h-[300px] w-[300px] rounded-full bg-purple-500/10 blur-[100px]" />
        </div>

        <div className="relative z-10 mx-auto max-w-4xl text-center">
          <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-zinc-800 bg-zinc-900/50 px-4 py-1.5 text-sm text-zinc-400">
            <Zap className="h-3.5 w-3.5 text-blue-500" />
            Không gian làm việc AI cho lập trình viên
          </div>
          <h1 className="mb-4 text-5xl font-bold tracking-tight md:text-7xl">
            AHV
            <span className="bg-gradient-to-r from-blue-400 to-blue-600 bg-clip-text text-transparent">
              claw
            </span>
          </h1>
          <p className="mb-2 text-2xl font-semibold text-zinc-300 md:text-3xl">
            AI Thực Thi
          </p>
          <p className="mx-auto mb-10 max-w-2xl text-base text-zinc-500 md:text-lg">
            Không chỉ trò chuyện — AI của bạn duyệt web, chạy lệnh,
            quản lý máy chủ, và hoạt động trên Telegram, Zalo & Discord.
          </p>
          <div className="flex flex-col items-center justify-center gap-4 sm:flex-row">
            <Link
              href="/login?register=true"
              className="group inline-flex items-center gap-2 rounded-xl bg-blue-600 px-8 py-3.5 text-sm font-semibold text-white transition-all hover:bg-blue-500 hover:shadow-lg hover:shadow-blue-500/25"
            >
              Bắt đầu miễn phí
              <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
            </Link>
            <Link
              href="/login"
              className="inline-flex items-center gap-2 rounded-xl border border-zinc-700 px-8 py-3.5 text-sm font-semibold text-zinc-300 transition-all hover:border-zinc-600 hover:bg-zinc-900 hover:text-white"
            >
              Đăng nhập
            </Link>
          </div>
        </div>
      </section>

      {/* Features Section */}
      <section className="relative px-6 py-24 md:py-32" id="features">
        <div className="mx-auto max-w-7xl">
          <div className="mb-16 text-center">
            <h2 className="mb-4 text-3xl font-bold md:text-4xl">
              Mọi thứ bạn cần để xây dựng với AI
            </h2>
            <p className="mx-auto max-w-2xl text-zinc-500">
              Không gian làm việc AI toàn diện vượt xa trò chuyện. Tự động hóa, lập trình,
              triển khai và quản lý — tất cả tại một nơi.
            </p>
          </div>
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {features.map((feature) => (
              <div
                key={feature.title}
                className="group rounded-2xl border border-zinc-800 bg-zinc-900/50 p-6 transition-all hover:border-zinc-700 hover:bg-zinc-900"
              >
                <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-lg bg-blue-500/10">
                  <feature.icon className="h-5 w-5 text-blue-500" />
                </div>
                <h3 className="mb-2 text-lg font-semibold">{feature.title}</h3>
                <p className="text-sm leading-relaxed text-zinc-500">
                  {feature.description}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Pricing Section */}
      <section className="relative px-6 py-24 md:py-32" id="pricing">
        {/* Subtle background gradient */}
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="h-[500px] w-[800px] rounded-full bg-blue-500/5 blur-[120px]" />
        </div>

        <div className="relative z-10 mx-auto max-w-7xl">
          <div className="mb-16 text-center">
            <h2 className="mb-4 text-3xl font-bold md:text-4xl">
              Bảng giá đơn giản, minh bạch
            </h2>
            <p className="mx-auto max-w-2xl text-zinc-500">
              Bắt đầu miễn phí. Nâng cấp khi bạn cần thêm sức mạnh.
            </p>
          </div>
          <div className="mx-auto grid max-w-5xl gap-6 lg:grid-cols-3">
            {pricingTiers.map((tier) => (
              <div
                key={tier.name}
                className={
                  "relative flex flex-col rounded-2xl border p-8 transition-all hover:border-zinc-700 " +
                  (tier.highlighted
                    ? "border-blue-500/50 bg-blue-500/5"
                    : "border-zinc-800 bg-zinc-900/50")
                }
              >
                {tier.highlighted && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-blue-600 px-3 py-1 text-xs font-semibold">
                    Đề xuất
                  </div>
                )}
                <div className="mb-6">
                  <h3 className="mb-1 text-lg font-semibold">{tier.name}</h3>
                  <p className="text-sm text-zinc-500">{tier.description}</p>
                </div>
                <div className="mb-6">
                  <span className="text-4xl font-bold">{tier.price}</span>
                  <span className="text-zinc-500">{tier.period}</span>
                </div>
                <ul className="mb-8 flex-1 space-y-3">
                  {tier.features.map((feature) => (
                    <li
                      key={feature}
                      className="flex items-center gap-3 text-sm text-zinc-400"
                    >
                      <Check className="h-4 w-4 shrink-0 text-blue-500" />
                      {feature}
                    </li>
                  ))}
                </ul>
                <Link
                  href={tier.href}
                  className={
                    "block rounded-xl py-3 text-center text-sm font-semibold transition-all " +
                    (tier.highlighted
                      ? "bg-blue-600 text-white hover:bg-blue-500"
                      : "border border-zinc-700 text-zinc-300 hover:border-zinc-600 hover:bg-zinc-800 hover:text-white")
                  }
                >
                  {tier.cta}
                </Link>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-zinc-800/50 px-6 py-12">
        <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-4 sm:flex-row">
          <div className="flex items-center gap-2">
            <Zap className="h-5 w-5 text-blue-500" />
            <span className="font-semibold">AHVclaw</span>
            <span className="text-zinc-600">|</span>
            <span className="text-sm text-zinc-500">Xây dựng bởi AHV Holding</span>
          </div>
          <p className="text-sm text-zinc-600">
            &copy; 2026 AHV Holding. Bảo lưu mọi quyền.
          </p>
        </div>
      </footer>
    </div>
  );
}
