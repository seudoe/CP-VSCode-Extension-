# Competitive Programming (seudoe)

The ultimate all-in-one Codeforces companion directly inside Visual Studio Code. Browse, read, code, and test Codeforces problems seamlessly without ever leaving your editor!

## 📌 Views & Sidebars

- **CF Problems**: A dedicated sidebar featuring an organized directory of Codeforces problems. Browse problems by *All*, *Tags*, *Ratings*, or explore *Past Contests*.
- **CF Test Cases**: A dynamic, interactive sidebar that manages inputs, expected outputs, and test execution for your current problem. 

## 🚀 Features

### Comprehensive Problem Discovery
- **Lists**: Browse problems by All, Tags, Ratings, and Contests.
- **Visual Features**: Clean, colored UI indicators (like problem difficulty ratings and colored labels).
- **User Integration**: See your Codeforces user details and view your submission history integrated right into the problems list!

### Seamless Coding Workflow
- **Beautiful Problem Renderer**: Renders Codeforces Problem Statements beautifully inside a VS Code webview, featuring full KaTeX math support and a clean dark-mode UI.
- **Code Now**: One click generates a local source code file tailored to your settings, automatically imports the problem's Input/Output tests, and sets up your environment instantly.
- **Boilerplates**: Start coding faster! Support for default boilerplates, custom inline boilerplates, or even loading boilerplates from an external file template. *Features robust error/warning notifications for boilerplate configuration issues.*

### Integrated Test Runner
- **Code Runner**: Run your code against the official test cases effortlessly inside VS Code.
- **Cross-Platform**: Fully supports Windows, Linux, and macOS environments.
- **Custom Compilers**: Supports different compilers for each type of programming language (e.g., configure `g++` or `clang++` for C++, `python` or `python3` for Python, etc.).
- **Visual Helper**: Clear visual feedback (green/red highlights) indicating exactly which test cases passed or failed.

## ⚙️ Extension Settings

Customize the extension to match your exact workflow. Access these through VS Code Settings by searching for `seuCF`.

- `seuCF.fileCreationDirectory`: Set an absolute or workspace-relative path where 'Code Now' will save your generated problem files.
- `seuCF.fileName`: Customize the template for naming generated files. (Placeholders include `{problemId}`, `{problemName}`, `{contestId}`, `{problemIndex}`, `{fileExtension}`).
- `seuCF.defaultFileExtension`: Set your default programming language extension (e.g. `.cpp`, `.py`) or leave it as "Select everytime" to be prompted.
- `seuCF.boilerplateCodes`: Define your custom boilerplate templates per language. You can write an array of strings or load from an absolute file path using the `file:` prefix (e.g., `"cpp": "file:C:\\templates\\cpp.txt"`).
- `seuCF.compilers`: Set your preferred compilers or interpreters for each language. (e.g., `{"cpp": "clang++", "py": "python3"}`).

## 🔮 Upcoming Features

We're constantly working to improve your CP workflow! Here are some features on the roadmap:
- Submit code to Codeforces directly from the extension!
- CP-31 Problems list integration.
- CSES Problem Set integration.
- Custom Checker support for test cases with multiple valid outputs.
- Additional UI toggles (Settings to enable/disable rating tags and colors in problem name labels).

---
*Created by [seudoe](https://github.com/seudoe/seudoe)*
