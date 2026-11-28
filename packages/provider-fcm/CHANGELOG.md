# Changelog

## [0.1.7](https://github.com/devkitshq/notifkit/compare/provider-fcm-v0.1.6...provider-fcm-v0.1.7) (2026-11-28)


### Bug Fixes

* **delivery:** send each push target only to providers that accept it ([ded378c](https://github.com/devkitshq/notifkit/commit/ded378c3bdbb5776a50810eaa1427a59693ae8c2))
* **provider-fcm:** use the template's title for the notification title ([#62](https://github.com/devkitshq/notifkit/issues/62)) ([221edf4](https://github.com/devkitshq/notifkit/commit/221edf4a1f73eaf0d77943540686d1365ba69cd2))
* **push:** send ntfy topics and onesignal ids only to their own provider ([e16fdca](https://github.com/devkitshq/notifkit/commit/e16fdcaecb714b51529e52bb61b02f14ce5a56d5))

## [0.1.6](https://github.com/devkitshq/notifkit/compare/provider-fcm-v0.1.5...provider-fcm-v0.1.6) (2026-11-22)


### Bug Fixes

* **providers:** stop timed-out sends landing twice, keep fcm apps apart ([141f11c](https://github.com/devkitshq/notifkit/commit/141f11c4edc6c108d4611b98d81e9b972d0b6f5c))

## [0.1.5](https://github.com/devkitshq/notifkit/compare/provider-fcm-v0.1.4...provider-fcm-v0.1.5) (2026-11-21)


### Bug Fixes

* **delivery:** stop a burst over a provider's rate limit from failing ([#44](https://github.com/devkitshq/notifkit/issues/44)) ([9bf61ad](https://github.com/devkitshq/notifkit/commit/9bf61ad89346344d6a1263893995c157b75cfe67)), closes [#36](https://github.com/devkitshq/notifkit/issues/36)

## [0.1.4](https://github.com/devkitshq/notifkit/compare/provider-fcm-v0.1.3...provider-fcm-v0.1.4) (2026-10-31)


### Bug Fixes

* **provider-fcm:** fail the send instead of throwing on a bad service account ([0a7724c](https://github.com/devkitshq/notifkit/commit/0a7724ca3080c630e7243d47b5e5ab928e3e9eb7))
