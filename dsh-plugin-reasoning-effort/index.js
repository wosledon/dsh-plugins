/**
 * 宿主半。
 *
 * 本插件的全部行为都在浏览器半（`./client`）：它把自己注册进
 * `settings.models.provider-card` 席位，为自定义供应商的每个模型编辑
 * `providers.<route>.models[].reasoningEfforts`。
 *
 * 这个条目存在的唯一理由是让 bundle 补丁有一个可插入的 Loader 条目 ——
 * `dsh-client-modules` 只扫描已启用条目的 `dsh.client` 声明。所以这里不注册
 * 任何服务、事件或工具，也就没有需要清理的副作用。
 */
export function apply() {}
