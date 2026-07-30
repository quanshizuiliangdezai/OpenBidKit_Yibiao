// 服务器 Node 环境下替代 Electron 的 app 对象。
// 原分析代码只通过 app.getPath('userData') 取数据目录，以及 app.once('before-quit') 注册退出钩子。
// 这里全部映射到服务器上的一个固定数据目录，使原逻辑零改动即可运行。
const path = require('node:path');

function createAppStub(dataDir) {
  const userData = dataDir;
  return {
    getPath: (name) => {
      if (name === 'userData') return userData;
      // 其他名称统一落在 userData 下，保持与原 Electron 行为兼容
      return path.join(userData, String(name));
    },
    isPackaged: false,
    getVersion: () => 'server-worker',
    once: () => {},
    on: () => {},
    // 兼容部分代码对 app 的非标准访问
    getPathSync: (name) => (name === 'userData' ? userData : path.join(userData, String(name))),
  };
}

module.exports = { createAppStub };
