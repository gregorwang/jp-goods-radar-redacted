# 消息用 org.json 手工解析，Room 适配器是生成的；依赖库自带的规则会自动合并，这里不用额外保留。

# security-crypto 依赖的 Tink 引用了只在编译期存在的 errorprone 注解。
-dontwarn com.google.errorprone.annotations.**
