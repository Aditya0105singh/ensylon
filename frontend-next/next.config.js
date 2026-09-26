
// Turbopack doesn't support dynamic imports yet, so we need to fallback to CDN for development
// Checking NODE_ENV because in the future we may use turbopack in production as well
const turbopackAliases =
  process.env.NODE_ENV === "development"
    ? {
        "./MonacoEditor": "@/shared/ui/MonacoEditor/index.turbopack.ts",
        "./MonacoYAMLEditor": "@/shared/ui/MonacoYAMLEditor/index.turbopack.ts",
        "./MonacoCel": "@/shared/ui/MonacoCELEditor/MonacoCel.turbopack.tsx",
      }
    : {};

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false,
  devIndicators: {
    position: "bottom-right",
  },
  experimental: {
    turbo: {
      resolveAlias: turbopackAliases,
    },
  },
  webpack: (
    config,
    { buildId, dev, isServer, defaultLoaders, nextRuntime, webpack }
  ) => {
    // Only apply proxy configuration for Node.js server runtime
    if (isServer) {
      console.log(` 🔐 AUTH_TYPE=${process.env.AUTH_TYPE}`);
      console.log(` 🔐 AUTH_DEBUG=${process.env.AUTH_DEBUG}`);
    }
    if (isServer && nextRuntime === "nodejs") {
      // Add environment variables for proxy at build time
      config.plugins.push(
        new webpack.DefinePlugin({
          "process.env.IS_NODEJS_RUNTIME": JSON.stringify(true),
        })
      );
    } else {
      // For edge runtime and client
      config.plugins.push(
        new webpack.DefinePlugin({
          "process.env.IS_NODEJS_RUNTIME": JSON.stringify(false),
        })
      );
    }

    // Ignore warnings about critical dependencies, since they are not critical
    // https://github.com/getsentry/sentry-javascript/issues/12077#issuecomment-2407569917
    config.ignoreWarnings = [
      ...(config.ignoreWarnings || []),
      {
        module: /require-in-the-middle/,
        message: /Critical dependency/,
      },
      {
        module: /@opentelemetry\/instrumentation/,
        message: /Critical dependency/,
      },
      {
        module: /@prisma\/instrumentation/,
        message: /Critical dependency/,
      },
    ];

    return config;
  },
  // @auth/core is ESM-only and jest fails to transpile it.
  // https://github.com/nextauthjs/next-auth/issues/6822
  transpilePackages: ["next-auth", "@auth/core"],
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "lh3.googleusercontent.com",
      },
      {
        protocol: "https",
        hostname: "avatars.githubusercontent.com",
      },
      {
        protocol: "https",
        hostname: "s.gravatar.com",
      },
      {
        protocol: "https",
        hostname: "avatar.vercel.sh",
      },
      {
        protocol: "https",
        hostname: "ui-avatars.com",
      },
      {
        protocol: "https",
        hostname: "cdn.prod.website-files.com",
      },
      // Cloudflare Image Delivery
      {
        protocol: "https",
        hostname: "imagedelivery.net",
      },
    ],
  },
  compiler: {
    removeConsole: process.env.NODE_ENV === "production",
  },
  output: "standalone",
  // Upstream redirected "/" to /incidents because Keep has no landing page.
  // AlertLens serves its overview dashboard at "/", so there is nothing to
  // redirect — and no DISABLE_REDIRECTS env var needed to keep it reachable.
  async redirects() {
    return [];
  },
  async headers() {
    // Allow Keycloak Server as a CORS origin since we use SSO wizard as iframe
    const keycloakIssuer = process.env.KEYCLOAK_ISSUER;
    const keycloakServer = keycloakIssuer
      ? keycloakIssuer.split("/auth")[0]
      : "http://localhost:8181";
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "Access-Control-Allow-Origin",
            value: keycloakServer,
          },
        ],
      },
    ];
  },
  rewrites: async () => {
    // do not leak source-maps in Vercel production deployments
    // but keep them in Vercel preview deployments with generated urls
    // for better dev experience
    // https://stackoverflow.com/a/70989748/12012756
    const isVercelProdDeploy =
      process.env.VERCEL_ENV === "production" ||
      process.env.NODE_ENV === "production";

    if (isVercelProdDeploy) {
      return {
        beforeFiles: [
          {
            source: "/:path*.map",
            destination: "/404",
          },
        ],
      };
    }

    return [];
  },
};

// Compose the final config
let config = nextConfig;

// Add Bundle Analyzer only when analysis is requested
if (process.env.ANALYZE === "true") {
  config = require("@next/bundle-analyzer")({
    enabled: true,
  })(config);
}

module.exports = config;
