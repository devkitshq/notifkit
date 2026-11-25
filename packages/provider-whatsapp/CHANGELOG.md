# Changelog

## [0.1.5](https://github.com/devkitshq/notifkit/compare/provider-whatsapp-v0.1.4...provider-whatsapp-v0.1.5) (2026-11-25)


### Bug Fixes

* **provider-vonage,provider-whatsapp:** cancel the request when delivery aborts the send ([aea574e](https://github.com/devkitshq/notifkit/commit/aea574ed6eaaa972c64ff44523320bb667cb55b1))
* **provider-vonage,provider-whatsapp:** refuse destinations that aren't a phone number ([cc585cc](https://github.com/devkitshq/notifkit/commit/cc585ccc0f47b9e62c393c2bbb34a5893ae831b5))

## [0.1.4](https://github.com/devkitshq/notifkit/compare/provider-whatsapp-v0.1.3...provider-whatsapp-v0.1.4) (2026-11-21)


### Bug Fixes

* **delivery:** stop a burst over a provider's rate limit from failing ([#44](https://github.com/devkitshq/notifkit/issues/44)) ([9bf61ad](https://github.com/devkitshq/notifkit/commit/9bf61ad89346344d6a1263893995c157b75cfe67)), closes [#36](https://github.com/devkitshq/notifkit/issues/36)

## [0.1.3](https://github.com/devkitshq/notifkit/compare/provider-whatsapp-v0.1.2...provider-whatsapp-v0.1.3) (2026-10-31)


### Bug Fixes

* **provider-whatsapp:** don't deactivate recipients when our access token expires ([0cf43dd](https://github.com/devkitshq/notifkit/commit/0cf43dd9a2736bc4919841c7d372f6ff7c87d1b9))
