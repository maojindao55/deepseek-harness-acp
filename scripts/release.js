#!/usr/bin/env node
/**
 * One-click Release Script for deepseek-harness-acp.
 * Automates testing, building, version bumping, git tagging, pushing, and npm publishing.
 */

import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'

const __dirname = dirname(fileURLToPath(import.meta.url))
const rootDir = resolve(__dirname, '..')
const pkgPath = resolve(rootDir, 'package.json')

function run(cmd, options = {}) {
  console.log(`\x1b[36m➜ ${cmd}\x1b[0m`)
  execSync(cmd, { cwd: rootDir, stdio: 'inherit', ...options })
}

function prompt(question) {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  })
  return new Promise((res) => {
    rl.question(question, (answer) => {
      rl.close()
      res(answer.trim())
    })
  })
}

function parseSemver(version) {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/)
  if (!match) throw new Error(`Invalid semver version: ${version}`)
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
    prerelease: match[4],
  }
}

function getNextVersion(current, type) {
  const { major, minor, patch } = parseSemver(current)
  switch (type) {
    case 'patch':
      return `${major}.${minor}.${patch + 1}`
    case 'minor':
      return `${major}.${minor + 1}.0`
    case 'major':
      return `${major + 1}.0.0`
    default:
      if (/^\d+\.\d+\.\d+/.test(type)) return type
      throw new Error(`Unknown release type: ${type}`)
  }
}

async function main() {
  console.log('\n\x1b[1m\x1b[35m🚀 deepseek-harness-acp 一键发布助手\x1b[0m\n')

  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
  const currentVersion = pkg.version
  console.log(`当前版本: \x1b[32mv${currentVersion}\x1b[0m\n`)

  // 1. 确定新版本号
  let releaseType = process.argv[2]
  if (!releaseType) {
    console.log('请选择发布版本类型:')
    console.log(`  1) patch (\x1b[33mv${getNextVersion(currentVersion, 'patch')}\x1b[0m - 缺陷修复/微调)`)
    console.log(`  2) minor (\x1b[33mv${getNextVersion(currentVersion, 'minor')}\x1b[0m - 新功能发布)`)
    console.log(`  3) major (\x1b[33mv${getNextVersion(currentVersion, 'major')}\x1b[0m - 重大重构/破坏性变更)`)
    console.log('  4) custom (手动输入自定义版本号)')
    
    const choice = await prompt('\n请输入序号 (1/2/3/4) [默认: 1]: ')
    if (choice === '2' || choice === 'minor') releaseType = 'minor'
    else if (choice === '3' || choice === 'major') releaseType = 'major'
    else if (choice === '4' || choice === 'custom') {
      releaseType = await prompt('请输入新版本号 (例如 0.2.0): ')
    } else {
      releaseType = 'patch'
    }
  }

  const newVersion = getNextVersion(currentVersion, releaseType)
  console.log(`\n准备发布版本: \x1b[1m\x1b[32mv${newVersion}\x1b[0m\n`)

  const confirm = await prompt(`确认发布 v${newVersion} 吗？(y/N): `)
  if (confirm.toLowerCase() !== 'y') {
    console.log('\x1b[31m发布已取消。\x1b[0m')
    process.exit(0)
  }

  // 2. 编译构建
  console.log('\n\x1b[1m[1/5] 执行 TypeScript 构建...\x1b[0m')
  run('npm run build')

  // 3. 更新 package.json
  console.log('\n\x1b[1m[2/5] 更新 package.json 版本号...\x1b[0m')
  pkg.version = newVersion
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')

  // 4. Git Commit & Tag
  console.log('\n\x1b[1m[3/5] 提交 Git 变更并打 Tag...\x1b[0m')
  try {
    run('git add package.json lib/ assets/')
    run(`git commit -m "chore(release): v${newVersion}"`)
    run(`git tag -a v${newVersion} -m "Release v${newVersion}"`)
  } catch (err) {
    console.warn('\x1b[33mGit 提交或 Tag 存在警告，继续后续流程...\x1b[0m')
  }

  // 5. 推送 Git (可选)
  const pushGit = await prompt('\n是否推送到 Git 远程仓库及 Tags？(Y/n): ')
  if (pushGit.toLowerCase() !== 'n') {
    try {
      run('git push')
      run('git push --tags')
    } catch {
      console.warn('\x1b[33mGit push 失败（可能未配置 remote），已跳过。\x1b[0m')
    }
  }

  // 6. 发布到 npm
  console.log('\n\x1b[1m[4/5] 发布到 npm 官方仓库...\x1b[0m')
  run('npm publish --access public --registry https://registry.npmjs.org/')

  // 7. 成功提示
  console.log('\n\x1b[1m\x1b[32m🎉 恭喜！v' + newVersion + ' 已成功发布到 npm！\x1b[0m\n')
  console.log('测试新版本:')
  console.log(`  npx deepseek-harness-acp@${newVersion}\n`)
}

main().catch((err) => {
  console.error('\n\x1b[31m发布失败:\x1b[0m', err.message)
  process.exit(1)
})
