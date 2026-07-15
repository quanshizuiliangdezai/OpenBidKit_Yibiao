// 测试用空签名器（no-op signer）
// 非管理员机器无 signtool，且 winCodeSign 解压需建符号链接被系统拒绝。
// 通过 build.win.sign 指定本脚本，彻底跳过 electron-builder 默认签名逻辑，
// 避免下载 winCodeSign 失败。仅用于本地测试构建，正式发布请移除该配置。
module.exports = async function ignoreSign(/* configuration */) {
  // configuration.path 为当前待签文件；测试构建直接放行，不做任何签名。
  return;
};
