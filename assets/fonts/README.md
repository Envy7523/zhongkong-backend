# 日报字体

`NotoSansSC-Numerals-Medium.ttf` 和 `NotoSansSC-Numerals-Bold.ttf` 从本目录现有的 `NotoSansSC-VF.ttf` 生成，分别固定为 500、700 字重，并仅保留 ASCII 字符及人民币符号 `¥`。字体内部家族名改为 `Daily Numerals Medium/Bold`，避免覆盖原中文字体。两份文件是普通 Git 文件，不依赖 Git LFS 下载。

日报图片的日期、金额、订单数及百分比使用这两份静态字形；中文继续使用原字体。字体授权见 [OFL.txt](OFL.txt)。
