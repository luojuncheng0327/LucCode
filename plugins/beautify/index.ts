export default class BeautifyPlugin {
  declare ctx: any;
  async onload() {
    this.ctx.log.info("beautify plugin loaded");
  }
}
