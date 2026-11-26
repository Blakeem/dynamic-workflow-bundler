export const context = this;
export const readContext = () => this;
export class Holder {
  self = this;
  static {
    this.kind = 'holder';
  }
  read() {
    return this.self;
  }
  [String(this)] = 'key';
}
