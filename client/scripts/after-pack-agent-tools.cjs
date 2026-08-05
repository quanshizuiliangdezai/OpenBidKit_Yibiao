const fs = require('node:fs');
const path = require('node:path');

function copyRecursive(source, target) {
  const stat = fs.lstatSync(source);
  if (stat.isDirectory()) {
    fs.mkdirSync(target, { recursive: true });
    for (const name of fs.readdirSync(source)) {
      copyRecursive(path.join(source, name), path.join(target, name));
    }
    return;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

function getResourcesDir(appOutDir, platform) {
  if (platform === 'darwin') {
    return path.join(appOutDir, 'Contents', 'Resources');
  }
  return path.join(appOutDir, 'resources');
}

// electron-builder 的 builder-util Arch 枚举：ia32=0, x64=1, armv7l=2, arm64=3, universal=4
function archToString(arch) {
  const map = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' };
  if (typeof arch === 'string') return arch;
  if (Object.prototype.hasOwnProperty.call(map, arch)) return map[arch];
  return String(arch);
}

module.exports = function afterPack(context) {
  const platform = context.electronPlatformName;
  const arch = archToString(context.arch);
  const key = `${platform}-${arch}`;
  const source = path.resolve(__dirname, '..', 'vendor', 'agent-tools', key);
  const resourcesDir = getResourcesDir(context.appOutDir, platform);
  const target = path.join(resourcesDir, 'agent-tools', key);

  if (!fs.existsSync(source)) {
    throw new Error(`Pi Agent 工具缺失：${source}（平台 ${platform} / 架构 ${arch}）`);
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  copyRecursive(source, target);

  const required = platform === 'win32'
    ? ['rg.exe', 'fd.exe', 'jq.exe']
    : ['rg', 'fd', 'jq'];
  for (const name of required) {
    const executable = path.join(target, 'bin', name);
    if (!fs.existsSync(executable)) {
      throw new Error(`Pi Agent 工具拷贝后缺失：${executable}`);
    }
  }

  console.log(`[afterPack] Agent tools copied: ${source} -> ${target}`);
};
